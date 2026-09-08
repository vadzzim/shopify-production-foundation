# ADR-0004: Bulk operations, not pagination, for the whole-catalog read

- **Status:** accepted
- **Date:** 2026-09-08

## Context

The app reads the catalog for two different purposes, and they are not the same
question.

**The picker.** The bundle editor offers products per routine step. It runs
inside a button press, needs an answer in a moment, and does not need every
product — a merchant chooses from a list they can look at.

**The report.** "How is this catalog set up for routine sets" — how many active
products carry each step, how many carry none, and which carry a value that is
not one of the three. That question is only meaningful over the *whole* catalog:
"14 cleansers among the first 2,500 products" is not an answer anyone can act
on, and a product whose metafield reads `moisturise` is invisible everywhere
else in this app precisely because nothing lists it.

Two constraints shape how that read can be done.

**The step cannot be filtered on.** `custom.routine_step` is deliberately not
admin-filterable (ADR-0003), so `products(query: "...")` cannot ask for it.
Worse, asking anyway is silent: an unsupported metafield filter returns the
whole catalog rather than an error. So grouping by step means reading every
active product and grouping in our own code.

**Rule 4.** A loop of Admin API calls must pace itself against
`extensions.cost.throttleStatus`, and for hundreds of objects or more the rule
names bulk operations rather than pagination. A development store has a few
dozen products; the base this repository is for will be pointed at catalogs
three orders of magnitude larger, where the difference is not academic.

## Options considered

1. **Paginate inside the request.** 250 products per page, loop until done,
   answer the HTTP request when finished.
   *Pro:* no new concepts; the code already exists for the starter bundle.
   *Con:* the time is unbounded and belongs to a merchant staring at a spinner —
   100,000 products is 400 sequential calls with throttle waits between them.
   Any cap on the number of pages turns the report into a claim about a prefix
   of the catalog, which is the thing the report exists to stop.
2. **Paginate inside a queue job.** The same loop, moved off the request.
   *Pro:* the merchant is not waiting, and the queue already exists.
   *Con:* it is still 400 calls against the shop's rate-limit bucket, competing
   with the webhook-driven jobs that are the point of the queue, and taking
   minutes of a worker that runs jobs one at a time. The cost scales with the
   catalog; it is the same read, just hidden.
3. **`bulkOperationRunQuery`, polled from the queue.** Shopify runs the query on
   its own infrastructure and writes a JSONL file.
   *Pro:* two cheap calls — start and poll — regardless of catalog size; no
   pagination to get wrong; no rate-limit pressure proportional to the data.
   *Con:* asynchronous, so the app needs somewhere to keep the operation id and
   something to poll with; the result is a file over plain HTTPS, on a URL that
   expires in seven days; starting an operation is not idempotent.
4. **`bulkOperationRunQuery` with the `bulk_operations/finish` webhook** instead
   of polling.
   *Pro:* no polling at all; Shopify says when it is done.
   *Con:* it makes the export depend on the one thing in this repository that
   has never been exercised against a live store — an actual webhook delivery
   from Shopify. Every delivery so far has been a signed `curl` of our own.

## Decision

**Option 3 for the report, option 1 for the picker**, and they are different
code paths on purpose.

The picker keeps its bounded pagination — ten pages, then it stops — and its
response says whether it reached the end of the catalog. The editor renders that
as "these are the first N active products", and points at the export for the
complete answer. A picker that silently shows a prefix is how a merchant
concludes a product cannot be added.

Within option 3, the operation is polled with `bulkOperation(id:)`, **not**
`currentBulkOperation`. The latter is what every tutorial shows and is
deprecated as of 2026-01 in favour of the former — the same trap as
`inventorySetOnHandQuantities` in ADR-0017, and invisible for the same reason:
it compiles, it validates, it works. It is also the wrong question now that an
app may run five bulk queries at once on a shop: "the current operation" is not
necessarily the one this job started.

## Rationale

The deciding argument is that options 1 and 2 make the *cost of the answer*
proportional to the catalog while the *value of the answer* is a handful of
numbers. Bulk operations move that work to the side of the boundary that already
has the data.

The second argument is honesty. A capped scan cannot say "no product carries the
moisturize step" — only "none of the first 2,500 does" — and the report exists
to be believed. Once a cap has to be explained in the UI, the feature is
already admitting it is the wrong mechanism.

Option 4 is better than option 3 and is not being taken *yet*. Polling can be
tested end to end locally, today, against a fake Shopify; the finish webhook
cannot be exercised at all until a real delivery has been seen. Choosing it now
would mean shipping the export on top of an untested assumption in order to save
a poll every fifteen seconds.

## Consequences

- **The report is a dated document, not a cache.** It says what the catalog
  looked like at `completedAt`. Nothing renders live state from it — product
  titles on the bundle screen are still read from the Admin API on every request
  (ADR-0007) — which is what makes it acceptable for the report to name
  products.
- **The queue gained a "waiting" outcome.** A poll whose budget ran out is not a
  failure, so `RetryLaterError` and `rescheduleJob` put the row back as PENDING
  and return the attempt the claim spent. Without that, an attempt budget meant
  to bound failures would be spent by an export succeeding slowly.
- **`Job.result` exists.** A nullable `jsonb` column, separate from `payload`,
  which is the input a retry re-reads.
- **Starting an export is a write that must not be repeated.** The operation id
  is recorded on the job row before any polling, so a retry resumes rather than
  starting a second export of the same catalog.
- **The result file is read as a stream.** Seven-day signed URL, JSONL, one
  product per line; `await response.text()` would hold a large catalog in memory
  to count three numbers.
- **Two catalog reads now exist** and could drift. The mitigation is that they
  ask for the same fields and the picker's limitation is stated in the response
  rather than assumed by the caller.

## When to revisit

- **When a real webhook delivery from Shopify has been observed** — the debt
  tracked in the roadmap. At that point `bulk_operations/finish` replaces the
  polling loop, and the job becomes: start, and be woken when it is done.
- **If the app ever needs per-product catalog data continuously** rather than a
  periodic report. That is no longer an export but a synchronisation, with a
  different set of problems — conflict resolution, echo suppression — recorded
  in ADR-0006.
