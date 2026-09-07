# Shopify Production Foundation

> A reusable base for Shopify client work — an Online Store 2.0 theme, an embedded
> admin app, and an integration layer — with the platform's sharp edges already
> handled rather than discovered under deadline.
>
> **NORDLYS** is the reference implementation: a DTC skincare brand on a
> development store, used to exercise the whole stack end to end. The brand and
> the external ERP are stand-ins; the code, the architecture and the measurements
> are real.

**Live**
- **Storefront:** <url> — development store password: `<password>`
- **App:** video walkthrough <loom-url>. An embedded admin app cannot be opened
  outside a store's admin, so it runs locally with a single command; deployment
  topology and rationale are in [ADR-0008](docs/adr/0008-hosting-topology.md).
  `Dockerfile` and `fly.toml` are in the repository.
- **Code:** this repository

---

## Why this exists

Every Shopify project re-solves the same problems, usually late:

- Webhook handlers that break on redelivery, because delivery is at-least-once
  and nothing deduplicates.
- Admin API loops that fall over on a real catalog, because nothing reads
  `throttleStatus` and nothing backs off.
- Mutations that return 200 and silently do nothing, because `userErrors` went
  unhandled.
- Content modelled as metafields where it belongs in metaobjects, then duplicated
  across products until the two drift apart.
- Themes where the merchant cannot change anything without a developer, because
  sections shipped without complete schemas.

This repository solves them once, with the reasoning recorded, so a client
project starts from a base instead of from Dawn plus improvisation.

## What is in it

| Area | Contents |
|---|---|
| **Theme** (OS 2.0) | Dawn-based, custom sections with complete schemas, metaobject-driven content, bundle builder on the Ajax Cart API |
| **App** | Embedded admin app: OAuth with offline and online tokens, Polaris UI, Admin GraphQL with cost-aware throttling and bulk operations |
| **Integration** | HMAC-verified idempotent webhook intake, queue on a PostgreSQL table with backoff and a DLQ status, inventory sync |
| **Quality** | Vitest + supertest, CI with theme-check, secret scanning and Lighthouse budgets, ADRs for every non-obvious decision |

## Architecture

```mermaid
flowchart LR
  Buyer[Customer] --> Theme[OS 2.0 Theme]
  Theme -->|Ajax Cart API| Shopify[(Shopify)]
  Merchant[Merchant] --> App[Admin App<br/>React + Polaris]
  App -->|Admin GraphQL| Shopify
  Shopify -->|webhooks HMAC| Receiver[Webhook Receiver<br/>Express]
  Receiver -->|enqueue| Queue[(Queue)]
  Queue --> Worker[Sync Worker]
  Worker -->|Admin GraphQL| Shopify
  Worker <-->|REST + webhooks| ERP[(External stock system)]
```

## Reference implementation

NORDLYS exercises the base against a realistic set of requirements, so the
foundation is proven rather than asserted:

1. **Custom routine sets.** Shopify has no native concept for them, so every set
   becomes a separate product — bloating the catalog and splitting inventory.
   Handled by the bundle builder, with line items linked by a `_bundle_id`
   line item property.
2. **Product page performance.** Measured before and after; see below.
3. **Inventory drift** between Shopify and an external system. Handled by
   idempotent webhook intake and a queue with retries.

## Measured results

Measured on the reference implementation. Methodology and full reports:
[`docs/performance/`](docs/performance/).

| Metric | Before | After |
|---|---|---|
| LCP (mobile) | | |
| CLS | | |
| INP | | |
| Lighthouse Performance | | |
| Lighthouse Accessibility | | |

## Engineering notes

- **Idempotent webhook handling.** Shopify guarantees at-least-once delivery, so
  duplicates are inevitable. Deduplication uses a unique index and
  `ON CONFLICT DO NOTHING` — not a `SELECT`-then-`INSERT` check, which is a race.
  The endpoint responds 200 before any work begins; the work goes to the queue.
- **Working within Admin GraphQL rate limits.** …
- **Bulk operations instead of pagination.** …
- **Bundle builder without libraries.** …

## Using this as a project base

```bash
docker compose up -d
pnpm install
cp .env.example .env
pnpm prisma migrate dev
pnpm dev
```

Already running PostgreSQL? Skip Docker and set `DATABASE_URL`.

To start a client project from this base: replace the brand tokens and the
sections under `theme/sections/`, keep the webhook intake, queue and Admin API
layer as they are, and swap the NORDLYS metaobject definitions for the project's
own content model. Conventions and hard rules are in [`CLAUDE.md`](CLAUDE.md);
setup detail in [`docs/development.md`](docs/development.md).

## Status

An early-stage foundation, not a finished product. What is deliberately designed
but not yet built is recorded with its reasoning in the
[roadmap](docs/roadmap.md):

- Shopify Function for bundle discounts.
- Checkout UI extension.
- Two-way sync with a DLQ and conflict resolution.
- Migrating the app off the Remix template to Express — ADR-0002.

## Authorship

All code, architecture and decisions are mine. Development is AI-assisted; the
approach, its boundaries, the data that is never shared with a model, and the
model mistakes caught in review are documented in
[`docs/ai-workflow.md`](docs/ai-workflow.md).

## Documentation

- [Roadmap and scope boundaries](docs/roadmap.md)
- [Local development](docs/development.md)
- [Architecture Decision Records](docs/adr/)
- [Estimates and actuals](docs/estimates.md)
- [AI-assisted workflow](docs/ai-workflow.md)
- [Performance measurements](docs/performance/)

## Development store constraints

- The storefront is always password-protected; that is a platform constraint,
  not a setting.
- Real payments are not possible; test orders go through the Bogus Gateway.
- The theme is published as a preview on Shopify's CDN: stable URL, always available.
