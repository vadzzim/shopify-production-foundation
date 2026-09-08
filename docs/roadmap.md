# Roadmap

Current state of the work and the boundaries of scope. Status markers are updated
as work progresses.

Each phase builds part of the reusable foundation; the NORDLYS reference
implementation exercises it against realistic requirements, so the completion
criteria are behavioural rather than "the code exists".

Legend: `[ ]` planned · `[~]` in progress · `[x]` done

---

## Phase 1 — Storefront

Custom routine sets and product page performance.

- [x] Dawn-based theme, Online Store 2.0 structure
- [x] Metaobject `ingredient` plus metafields `custom.ingredients`,
      `custom.routine_step` — see [ADR-0003](adr/0003-metaobjects-for-ingredients.md)
- [x] `ingredient-highlights` section — complete schema (`settings`, `blocks`,
      `presets`), assemblable by a merchant in the theme editor without code
      changes — see [ADR-0010](adr/0010-section-composition-field-blocks.md)
- [x] `bundle-builder` section — pick three products by routine step, add to cart
      in a single `/cart/add.js` request, line items linked by the `_bundle_id`
      line item property — see
      [ADR-0012](adr/0012-bundle-add-to-cart-transaction.md)
- [x] Cart edge cases handled: sold out, variant unavailable, network failure
- [x] Performance: measured before/after per optimisation — see
      [`docs/performance/`](performance/). Preloading the LCP image turned out
      not to apply: the home page LCP element is text, and Shopify caps preload
      Link headers at ten with image preloads sorted last
      (`srcset`/`sizes`, deferred scripts, reserved dimensions and
      `font-display: swap` were already Dawn's, and the report says so)
- [x] Accessibility: keyboard navigation, `aria-live` on async updates, contrast
      >= 4.5:1, and focus moving into the cart notification and back to the
      element that opened it. The criterion originally said "focus trap in the
      cart drawer"; the drawer is not enabled (`cart_type: "notification"`), so
      it named a component the theme does not ship — see
      [ADR-0014](adr/0014-cart-notification-over-drawer.md)
- [x] `shopify theme check` clean — no errors. The 11 remaining warnings are all
      in stock Dawn files (`UndefinedObject`, `UnusedAssign`, `VariableName`,
      `OrphanedSnippet`); none is in code this project authored, and CI gates on
      `--fail-level error`

**Boundaries:** no libraries — vanilla JS and web components in Dawn's style.

**Completion criterion:** before/after measurements in
[`performance/`](performance/) broken down per optimisation, not as one aggregate
number.

---

## Phase 2 — Admin app

Bundle management and sync observability.

- [x] OAuth, offline plus online tokens, session storage
      (`@shopify/shopify-app-session-storage-prisma`). Built on Express with
      `@shopify/shopify-app-express` rather than Shopify's app template — see
      [ADR-0002](adr/0002-express-over-the-app-template.md)
- [x] Prisma schema and first migration
- [x] Env validated with zod, failing at startup rather than on first use
- [x] Metafield and metaobject definitions created on app install
      (`metafieldDefinitionCreate`) — the app prepares the store itself.
      Idempotent: `TAKEN` is a success, anything else is not
- [x] Polaris UI: bundle list, empty state, explicit error messages, the sync
      log, and editing — title, status and one product per step, in a modal,
      with delete behind a confirmation. The criterion said "skeletons": Polaris
      1.0 ships no skeleton component, so the table's own `loading` state is
      what the screen uses — see
      [ADR-0015](adr/0015-polaris-web-components-over-polaris-react.md)
- [x] Admin GraphQL: `extensions.cost.throttleStatus` read with backoff and
      jitter, and `userErrors` handled in every mutation. The whole-catalog read
      is a bulk operation polled from the queue, not a paginated loop — see
      [ADR-0004](adr/0004-bulk-operations-over-pagination.md). The editor's
      product picker keeps the bounded scan and says so when it did not reach
      the end of the catalog

**Completion criterion:** the app installs on a clean store and works with no
manual data preparation. **Not yet verified** — `shopify app init` and
`shopify app dev` are interactive, so the install has not been run end to end
against `ecorn-oj1cb5ll`. Everything below the install is exercised by tests.

Every feature of this phase is now written; what is missing is the one thing
tests cannot supply. The two are kept apart deliberately: the boxes above are
about code that exists and is exercised, the criterion is about a store.

---

## Phase 3 — Webhooks and synchronisation

- [x] HMAC verification against the raw `Buffer` before JSON parsing, using
      `crypto.timingSafeEqual`. Written rather than delegated to
      `shopify.processWebhooks()`, which verifies against a decoded string with
      a hand-written comparison and answers only after its handlers finish — see
      [ADR-0016](adr/0016-webhook-ingestion.md)
- [x] Idempotency on `X-Shopify-Webhook-Id`: primary key plus
      `ON CONFLICT DO NOTHING`, in the same transaction as the enqueue.
      Exercised against PostgreSQL, including three concurrent deliveries of one
      event
- [x] The endpoint responds 200 before any work begins; work goes to the queue.
      Asserted: after the response the job is `PENDING` with zero attempts
- [x] Queue on a PostgreSQL table, jobs claimed with `FOR UPDATE SKIP LOCKED`,
      exponential backoff with jitter, attempt limit, `DEAD` as the dead-letter
      state, and a reaper for jobs whose worker disappeared
- [x] Topics: `orders/create`, `products/update`, `app/uninstalled`.
      Uninstall clears sessions and deliberately keeps bundles — deletion is
      `shop/redact`'s job, 48 hours later (ADR-0016)
- [x] Compliance topics: `customers/data_request`, `customers/redact`,
      `shop/redact`. The first two are no-ops **by design** — this database holds
      no customer personal data — and a test asserts that premise rather than
      trusting it
- [x] Structured logs (pino) with a correlation id carried from webhook receipt
      through the queue to the Admin API call. The id is Shopify's own delivery
      id, so a log line matches a row in the platform's delivery log
- [~] Inventory sync on the InventoryItem × Location pair, with
      `inventorySetQuantities` — not the `inventorySetOnHandQuantities` the plan
      named, which is deprecated in 2026-07 (see
      [ADR-0017](adr/0017-inventory-writes.md)). The handler, the absolute-value
      semantics and the job-id idempotency key are written and tested; **what
      produces these jobs is not**. That is the mock ERP, which is roadmap v2, so
      today they are enqueued by hand

**Completion criterion:** redelivery of the same webhook creates no duplicate;
an external system failure is visible in the UI and can be retried manually.
**Met**, and by tests rather than by observation: the duplicate case is asserted
against a real PostgreSQL over real HTTP, and the sync log renders a failed job
with its reason and a Retry button that puts it back on the queue.

Not verified against a live store. The app has still never been opened in the
admin — the IPv6 loopback problem in `docs/development.md` blocks the tunnel, and
webhooks need one. What that would add is confirmation that Shopify's headers and
payloads are what the tests assume; the logic itself is exercised end to end
locally.

---

## Phase 4 — Quality and reproducibility

- [~] Tests: HMAC (valid, invalid and missing signature, tampered body),
      idempotency, backoff on an exhausted bucket, `userErrors` handling and the
      bulk-export state machine are done. Variant-to-external-SKU mapping is not
      — it needs the mock ERP
- [x] CI: typecheck, lint, tests, `shopify theme check`, secret scan, Lighthouse
      budgets (non-blocking, report as an artifact). The app job now runs a
      `postgres:16-alpine` service, so the idempotency and `SKIP LOCKED` suites
      run on every pull request instead of only where Docker happens to be up
- [ ] `docker-compose.yml` — the project starts for anyone who clones the repository
- [ ] Theme published as a preview on Shopify's CDN

---

## Roadmap v2 — designed, not implemented

Deliberately outside the current stage. Decisions are recorded; execution deferred.

### Full integration

- `services/mock-erp` — a standalone service with REST, signed outbound webhooks,
  and injected failures (500s on a fraction of requests, delays, duplicates).
  Without failures, retries and idempotency are not genuinely exercised.
- Two-way sync with separate queues, a DLQ, and a UI for manual triage.
- Conflict resolution: last-write-wins on the source timestamp, echo suppression
  via a `syncOrigin` marker, unresolved divergence reported rather than silently
  overwritten. See ADR-0006.
- Moving the queue from a table to BullMQ + Redis as load grows. See ADR-0007.

### Rebasing the theme on Skeleton

Stage 1 builds on Dawn because its third day is an Ajax cart and Skeleton ships
no JavaScript at all. Skeleton is the better long-term base — 2,294 lines
against Dawn's 134,066, and it has theme blocks. Porting the sections and
converting ADR-0010's field blocks to theme blocks belongs here, once the cart
layer exists to carry over. See [ADR-0011](adr/0011-dawn-over-skeleton-theme.md).

### Extension points

- `bundle-block` — theme app extension: the merchant inserts the block from the
  theme editor, and the app stops depending on theme code edits.
- `bundle-discount` — Shopify Function applying a discount by `_bundle_id`. It
  runs in a WASM sandbox with no network and no state, so everything it needs
  must already be in metafields.
- `checkout-gift` — Checkout UI extension.

### Infrastructure

- Types generated from the GraphQL schema instead of the hand-written response
  interfaces in `apps/admin-app/src/server`
- Playwright e2e against the preview theme
- `/healthz`, `/readyz`, counters for processed and failed jobs
- Extracting the worker into its own process (it currently runs inside the app)

---

## Rejected

- **Hydrogen / Oxygen.** Headless is justified by a complex content layer or
  multichannel requirements. As the default for a general-purpose base it would
  triple the work and constrain every project built on it. See ADR-0005.
- **Subscriptions / selling plans.** A large separate domain that dilutes focus.
- **Duplicating the catalog in our own database.** Shopify remains the source of
  truth for domain data. See ADR-0007.
