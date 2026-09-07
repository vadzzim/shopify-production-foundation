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

- [ ] OAuth, offline plus online tokens, session storage
      (`@shopify/shopify-app-session-storage-prisma`)
- [ ] Prisma schema and first migration
- [ ] Env validated with zod, failing at startup rather than on first use
- [ ] Metafield and metaobject definitions created on app install
      (`metafieldDefinitionCreate`) — the app prepares the store itself
- [ ] Polaris UI: bundle list, editing, sync log page; empty states, skeletons,
      explicit error messages
- [ ] Admin GraphQL: `bulkOperationRunQuery` for catalog export, handling of
      `extensions.cost.throttleStatus` with backoff and jitter, `userErrors`
      handled in every mutation

**Completion criterion:** the app installs on a clean store and works with no
manual data preparation.

---

## Phase 3 — Webhooks and synchronisation

- [ ] HMAC verification against the raw `Buffer` before JSON parsing, using
      `crypto.timingSafeEqual`
- [ ] Idempotency on `X-Shopify-Webhook-Id`: unique index plus
      `ON CONFLICT DO NOTHING`
- [ ] The endpoint responds 200 before any work begins; work goes to the queue
- [ ] Queue on a PostgreSQL table, jobs claimed with `FOR UPDATE SKIP LOCKED`,
      exponential backoff, attempt limit, DLQ status
- [ ] Topics: `orders/create`, `products/update`, `app/uninstalled` with data cleanup
- [ ] GDPR topics: `customers/data_request`, `customers/redact`, `shop/redact`
- [ ] Structured logs (pino) with a correlation id carried from webhook receipt
      through to the Admin API call
- [ ] Inventory sync accounting for the fact that stock lives on the
      InventoryItem × Location pair

**Completion criterion:** redelivery of the same webhook creates no duplicate;
an external system failure is visible in the UI and can be retried manually.

---

## Phase 4 — Quality and reproducibility

- [ ] Tests: HMAC (valid, invalid and missing signature, tampered body),
      idempotency, backoff on an exhausted bucket, `userErrors` handling,
      variant-to-external-SKU mapping
- [ ] CI: typecheck, lint, tests, `shopify theme check`, secret scan, Lighthouse
      budgets (non-blocking, report as an artifact)
- [ ] `docker-compose.yml` — the project starts for anyone who clones the repository
- [ ] Theme published as a preview on Shopify's CDN

---

## Roadmap v2 — designed, not implemented

Deliberately outside the current stage. Decisions are recorded; execution deferred.

### Migrating the app to Express

The app currently runs on Shopify's default Remix template; the webhook receiver
and the worker are on Express. A full move to Express gives control over the
middleware layer. See ADR-0002.

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

- pnpm workspace, `packages/shared` for shared types and zod schemas
- Types generated from the GraphQL schema instead of hand-written definitions
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
