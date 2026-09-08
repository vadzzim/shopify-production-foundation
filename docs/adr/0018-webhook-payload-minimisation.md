# ADR-0018: A webhook delivery is projected before it is stored, and the queue is redactable

- **Status:** accepted
- **Date:** 2026-09-08

## Context

The webhook endpoint (ADR-0016) records a delivery and enqueues its work in one
transaction, and the job carries the delivery body in `Job.payload` — a `jsonb`
column, so one queue table serves every topic without a table per kind
(ADR-0007).

Storing the body as it arrived turned out to have consequences nobody decided
on:

- An `orders/create` delivery carries the customer's name, email, phone, both
  addresses and the order totals. A `customers/redact` delivery carries the
  email of the person asking to be forgotten. All of it landed in `Job.payload`.
- The handlers read almost none of that. Across all six subscribed topics what
  is actually used is: an order name and the `_bundle_id` line item properties,
  a product id, and the identifiers on a compliance request. The rest was stored
  because it was in the envelope.
- Neither compliance handler removed any of it. `customers/redact` logged that
  there was nothing to redact; `shop/redact` deleted `Bundle`, `Session` and
  `WebhookDelivery`. Nothing cascades to `Job` — a job outlives the delivery
  that created it on purpose, so that a failure stays in the sync log after the
  delivery row is gone — so the queue was untouched by both.
- The comment above the compliance handler stated that this database holds no
  customer personal data, which is what makes `customers/data_request` an answer
  of "nothing" rather than an unimplemented handler. That statement was false
  while the order payloads sat in the queue, and the test it claimed enforced it
  did not exist.

`Job.payload` is the only column in this schema that holds whatever a webhook
happened to carry. Every other table has columns someone chose.

## Options considered

1. **Store the body verbatim, redact on the compliance topics.** ➕ Nothing to
   design; the payload is available for debugging anything. ➕ One place to
   change when a handler starts needing another field. ➖ Redaction has to know
   every shape that may contain personal data, per topic, and stay correct as
   Shopify adds fields to payloads — a `customers/redact` that misses a field is
   silent. ➖ The data is in every backup taken before the redaction, which no
   handler can reach. ➖ A retention question for a column with no retention
   policy: nothing deletes a SUCCEEDED job.
2. **Store the body verbatim, and add a retention job.** ➕ Bounds the exposure
   without deciding per topic. ➖ Bounds it in *time* only: for as long as the
   window is, everything is still there. ➖ A sync log that forgets its own
   history after N days is a worse sync log, so the window fights the feature.
   ➖ Still needs option 1's per-topic redaction for the 30-day compliance
   obligation, which does not wait for a retention window.
3. **Project the body onto the fields its handler reads, at the door.** ➕ Data
   never stored needs no redaction, appears in no backup, and cannot be missed
   by a `deleteMany`. ➕ The set of stored fields is small enough to read in one
   screen and assert on. ➖ A handler that needs a new field needs the projection
   changed too, and the failure mode — a field silently absent — is one a
   handler must fail loudly on rather than treat as missing data. ➖ A payload
   kept for debugging is no longer the payload Shopify sent.

## Decision

Option 3, plus the queue in both redaction paths.

The projection lives in `webhook-payload.ts` as a total `Record` over the topic
union, like `JOB_KIND_BY_TOPIC` beside it: subscribing to a new topic does not
inherit "store the whole body", it fails to compile until someone decides what
of it may be kept. Line item properties are filtered to `_bundle_id`, because
the others are storefront-written and can carry a gift message.

`shop/redact` deletes the shop's jobs. `customers/redact` deletes the earlier
compliance requests that name that customer, matched with a `jsonb` path filter.
Both spare exactly one row — their own: the worker marks it SUCCEEDED after the
handler returns, and that update finds nothing if the row is gone, leaving a
redaction that did its work and reported as failed.

## Rationale

What tipped it is that options 1 and 2 both keep the data and then try to be
disciplined about it, and the discipline has to hold across a payload format
this project does not control. Shopify can add a field to `orders/create` in a
future API version; under option 1 that field is stored, and our redaction does
not know about it. Under option 3 it is dropped by a projection that lists what
it keeps.

The cost is real and worth naming: `Job.payload` is no longer a faithful copy of
what Shopify sent, so a bug that turns on a field nobody kept cannot be
diagnosed from the row. The correlation id is the answer — it is on the row, on
every log line the job produced, and on the delivery in the Partner dashboard —
and the logs are where a full payload belongs, with a retention policy of their
own, rather than in a table that keeps rows indefinitely.

## Consequences

- `customers/data_request` can honestly answer "nothing", and the claim is now
  checkable: the projection's tests assert that an order payload retains no
  email, phone, address or customer id.
- A handler that starts needing another field needs a change in two files, and
  the projection is the one to change first. A handler that finds a field
  missing must fail the job (`PermanentJobError`), not carry on with a default —
  otherwise a projection mistake looks like sparse data from Shopify.
- The sync log shows less about what a job was about. Order name and product id
  are what is left, which is what its screen displays anyway.
- Deleting the shop's jobs on `shop/redact` also deletes DEAD rows a merchant
  might have retried. That is what erasure means; the alternative is keeping
  failure history for a shop that asked to be forgotten.

## When to revisit

When a handler needs a field the projection does not keep and the argument for
keeping it is "for debugging" rather than "the handler reads it" — that is the
point to decide whether the debugging case deserves a separate, retained,
short-lived store rather than a widened projection. Also if a topic is
subscribed whose handler genuinely needs most of its payload (an
`orders/updated` reconciliation would), because then the projection stops paying
for itself on that topic and the honest thing is to say so in this ADR.
