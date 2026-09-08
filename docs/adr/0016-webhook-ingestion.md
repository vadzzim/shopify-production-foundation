# ADR-0016: Webhook ingestion — app-specific subscriptions, own HMAC verification

- **Status:** accepted
- **Date:** 2026-09-08

## Context

Phase 3 makes this app receive webhooks. Two questions had to be settled before
any of it could be written, and both have a plausible default that turns out to
be wrong here.

`CLAUDE.md` rule 3 says: *verify the HMAC against the raw `Buffer` before JSON
parsing, using `crypto.timingSafeEqual`; deduplicate on `X-Shopify-Webhook-Id`;
respond 200 before doing any work.* ADR-0002 says the opposite-sounding thing:
authentication code is vendor-maintained, and reimplementing it is how a project
loses a week and gains a vulnerability. `@shopify/shopify-app-express` ships
`shopify.processWebhooks()`, which verifies HMACs. Whether using it satisfies
rule 3 is the question, not a formality.

Separately, Shopify offers two ways to subscribe, they behave differently, and
mixing them on one topic delivers that topic twice.

Everything below about the SDK was read out of the installed sources
(`node_modules/.pnpm/@shopify+shopify-api@14.0.1`,
`@shopify+shopify-app-express@8.0.1`), not inferred from documentation.
Everything about the platform was confirmed through the Shopify Dev MCP against
2026-07.

## Decision 1 — app-specific or shop-specific subscriptions

### Shop-specific (created through the Admin API)

- ➕ Can differ per shop: a different URI, different filters, different fields.
- ➕ Have an id, so an individual subscription can be queried and traced in the
  webhook logs.
- ➖ Have to be created on every install, by our code, which can fail.
- ➖ **Cannot carry the mandatory compliance topics at all.** `customers/data_request`,
  `customers/redact` and `shop/redact` are not subscribable through the Admin
  API, so those would need the config file anyway — and then both mechanisms are
  in play.
- ➖ **The adapter deletes the ones it does not recognise.** `shopify.auth.callback()`
  calls `registerWebhooks`, which calls `api.webhooks.register()`. That function
  reads every existing shop-specific subscription and, for each topic not in the
  SDK's own `webhookRegistry`, issues a delete. Any subscription we created
  outside the SDK's registry is removed on the next OAuth round trip, silently.

### App-specific (declared in `shopify.app.toml`)

- ➕ Shopify's own recommendation for apps whose subscriptions do not vary per
  shop, which is ours.
- ➕ Applied to every shop that installs the app, by the platform. Nothing to run
  at install time, so nothing to fail at install time.
- ➕ The only place the compliance topics can be declared.
- ➕ Invisible to `api.webhooks.register()`: `webhookSubscriptions` returns *"only
  shop-scoped subscriptions, not app-scoped subscriptions configured in TOML
  files"*, so the deletion pass above cannot touch them.
- ➖ No per-subscription id in the webhook logs; they appear as `config-managed`.
- ➖ Changes reach production only on `shopify app deploy`, not on a code deploy.
- ➖ `shopify app config link` rewrites the file wholesale and has already
  reverted `api_version` once (see ADR-0009).

**Decision: app-specific, exclusively.**

The deciding argument is not the recommendation, it is that the alternative is
not actually available. Two of the six topics can only be declared in the config
file, so "shop-specific" really means "both mechanisms at once" — and both at
once is the one combination Shopify warns produces duplicate deliveries, on top
of the adapter quietly deleting whatever it does not know about.

Nothing in this app needs subscriptions to vary between shops. The moment
something does — per-merchant filters, say — this is worth revisiting, and the
deletion trap above is what to plan around when it is.

The cost is accepted deliberately: the last two drawbacks are both "the config
file is not code", and they are mitigated by a test
(`packages/shared/src/jobs.test.ts`) that reads the TOML and asserts its topics
against `WEBHOOK_TOPICS` and its `uri` against the server's `webhooks.path`.

## Decision 2 — the adapter's HMAC verification, or our own

### `shopify.processWebhooks({ webhookHandlers })`

- ➕ Vendor-maintained. A change in how Shopify signs deliveries arrives as a
  dependency update rather than as an incident.
- ➕ Zero code, and it is what every Shopify example does.
- ➖ **The body is never a `Buffer`.** The middleware is
  `express.text({type: '*/*', limit: '500kb'})`, so verification receives a
  `string` decoded through a charset. Any byte sequence that is not valid UTF-8
  becomes U+FFFD, and the HMAC is then computed over different bytes than
  Shopify signed. Shopify sends UTF-8, so this works — until it does not, and
  the symptom is a valid delivery failing verification with nothing in the logs
  to explain it. Rule 3 names `Buffer` for exactly this class of failure.
- ➖ **The comparison is not `crypto.timingSafeEqual`.** `safeCompare` in
  `@shopify/shopify-api` JSON-stringifies both sides and XORs them in a
  JavaScript `for` loop. It checks lengths first, so it is constant-time in
  intent — but a JIT-compiled userland loop carries no such guarantee from the
  engine, which is the entire reason Node exposes a primitive that does.
- ➖ **It cannot answer before it works.** `api.webhooks.process()` awaits
  `callWebhookHandlers` and only then converts and writes the response. Rule 3's
  ordering is not merely unimplemented there; it is structurally impossible.
- ➖ Its status codes do not match Shopify's own review requirement: a missing
  HMAC header is answered `400`, where the compliance checklist asks for `401`
  on an invalid HMAC header.

### Our own verification (`apps/admin-app/src/server/webhook-verify.ts`)

- ➕ Satisfies rule 3 literally: `express.raw()`, `createHmac(...).update(buffer)`,
  `crypto.timingSafeEqual`, and the response written before any handler exists
  to run.
- ➕ The order of checks is ours to state and to test: signature first, then
  headers, then the body parsed — so nothing acts on the contents of an
  unauthenticated request, not even to decide which topic it claims to be.
- ➕ `401` for both a forged and a missing signature, matching the review
  requirement.
- ➖ Ours to keep correct. A change in Shopify's signing scheme lands on us.
- ➖ Roughly sixty lines that did not need to exist.

**Decision: our own, for the HMAC; the adapter keeps OAuth.**

This is a narrower exception to ADR-0002 than it looks. What ADR-0002 argues is
that *OAuth* should not be hand-written — a multi-step protocol with token
exchange, state, and session storage, where a subtle mistake is a compromise.
That still stands, and none of it is touched here: `shopify.auth.begin()` and
`shopify.auth.callback()` remain the adapter's.

Verifying a webhook is one HMAC and one comparison. The vendor implementation
gets two of rule 3's three requirements wrong and cannot satisfy the third at
all, and the third — answering before working — is not a style preference: a
handler slower than Shopify's delivery timeout produces a redelivery, which
produces another slow handler. Delegating here would mean writing a rule into
`CLAUDE.md` and then not following it, which is worse than either honest option.

The cost is paid down by tests rather than by hope:
`webhook-verify.test.ts` covers a valid signature, a forged one, a missing one,
a tampered body, a single flipped byte, a wrong-length signature, an empty body,
a repeated header, and a body that reached the verifier already parsed.

## Decision 3 — how the three compliance topics are handled

They share one job kind, `compliance.request`, because they differ in what they
ask for rather than in how they are received: acknowledged immediately, recorded,
and then discharged.

What each means for this app follows from what it stores, and that is worth
stating plainly: **there is no customer personal data in this database.** The
schema holds OAuth sessions (staff, not customers), bundle definitions, webhook
delivery ids and job rows.

- `customers/data_request` — nothing to gather. Logged and answered.
- `customers/redact` — nothing to erase. Logged and answered.
- `shop/redact` — the instruction to erase, and the one that deletes: bundles,
  sessions and delivery records for that shop.

The first two are only a defensible answer while the premise holds, so
`job-handlers.test.ts` asserts it rather than trusting it: add a table keyed to a
customer and the test fails here, rather than during an app review.

This is also why `app/uninstalled` deliberately does **not** delete bundles.
Uninstalling is not a request to be forgotten — a merchant who reinstalls next
week expects their routine sets to still be there — and Shopify's own deletion
obligation arrives separately as `shop/redact`, 48 hours later. Deleting on
uninstall would make that webhook meaningless and lose data for the commonest
reason an app is removed, which is someone trying it.

## Consequences

- `shopify.processWebhooks()` is never called, so the adapter's own
  `APP_UNINSTALLED` handler — which it mounts as a side effect of that call — is
  not mounted either. Clearing sessions on uninstall is ours, and is the
  `shop.cleanup` handler.
- `api.webhooks.register()` still runs on every offline OAuth callback, with an
  empty registry. It costs one `webhookSubscriptions` query per install and
  deletes nothing, because there is nothing shop-specific to delete. Left alone
  rather than suppressed: it is inside `shopify.auth.callback()`, and reaching
  into that to disable one call would be a worse dependency than the query.
- Adding a topic means three edits — `WEBHOOK_TOPICS`, `JOB_KIND_BY_TOPIC`, and
  `shopify.app.toml` — and the test suite fails until all three agree.
- Subscription changes need `shopify app deploy`, which is a step a code-only
  deploy does not include.

## When to revisit

- A merchant needs a subscription that differs from every other merchant's →
  shop-specific becomes necessary, and the deletion behaviour of
  `api.webhooks.register()` has to be handled at the same time.
- `@shopify/shopify-app-express` starts verifying against the raw body with
  `crypto.timingSafeEqual`, and exposes a way to respond before handlers run →
  the argument for our own implementation is gone and it should be deleted.
- Shopify changes the signing scheme or the header set → this is the file that
  has to change, which is the cost decision 2 accepted.
