# ADR-0007: PostgreSQL + Prisma, queue on a table

- **Status:** accepted
- **Date:** 2026-09-07

## Context

The app needs persistent storage. The actual requirements:

| Data | Access pattern |
|---|---|
| OAuth tokens (session storage) | low write volume, durability critical |
| Webhook idempotency keys | high write volume, unique index, expiry |
| Sync job queue | concurrent claiming, retries, DLQ |
| Sync log | append-only, grows linearly with orders |
| Shopify variant ↔ external SKU mapping | low write volume, frequent reads |

Constraints: one developer, limited time budget. The app runs locally
(see ADR-0008); PostgreSQL is already installed on the development machine.

### What deliberately does not go into our database

Bundle definitions live in **Shopify metaobjects**, not here. Reasons: the theme
reads them directly from Liquid without calling our API; the merchant can see and
edit them in the admin; they survive app uninstall; and no second source of truth
appears that would then need syncing against the first.

The principle: **Shopify is the source of truth for domain data. Our database is
only for what Shopify cannot hold — secrets, plumbing, high-frequency telemetry.**
Apps that mirror the catalog "just in case" create permanent drift.

## Decision 1 — the database

### MongoDB + Mongoose

- ➕ Familiar tool, prior experience.
- ➕ Convenient TTL indexes for webhook deduplication.
- ➖ The data is strictly relational; schema flexibility buys nothing here.
- ➖ Requires a separate session storage adapter and more manual work.

### SQLite

- ➕ Zero setup, zero accounts, a file in the project.
- ➕ Fits the load profile of a single instance entirely.
- ➖ Prisma's SQLite provider supports neither `enum` nor scalar lists, so the
  schema would have to be written with a future migration in mind.
- ➖ On a PaaS with an ephemeral filesystem the database file is wiped on redeploy:
  tokens are lost and the app breaks silently.

### PostgreSQL

- ➕ `INSERT ... ON CONFLICT` and `FOR UPDATE SKIP LOCKED` are native — exactly
  the idempotency and queue primitives needed here.
- ➕ `jsonb` covers storage of raw webhook payloads.
- ➕ Full parity between local development and any future production environment.
- ➖ Requires a running service. Mitigated by `docker-compose.yml` in the repository.

**Decision: PostgreSQL.**

The case for SQLite rested on "zero setup", but PostgreSQL is already installed
locally, so that advantage disappears while the limitations remain. The case for
MongoDB rested on familiarity rather than on the shape of the data: it is strictly
relational here, and schema flexibility is not needed. Choosing storage out of
habit when the access pattern points elsewhere is exactly the kind of decision
code review should catch.

## Decision 2 — the ORM

### Prisma

- ➕ **Official `@shopify/shopify-app-session-storage-prisma`.**
- ➕ Mature migrations (`prisma migrate dev`).
- ➕ Prisma Studio provides a database GUI, which speeds up sync debugging.
- ➕ The default in Shopify's template, so it is what inherited projects most
  often use.
- ➖ Cannot express `FOR UPDATE SKIP LOCKED`; heavier runtime; less control over SQL.

### Drizzle

- ➕ Schema in TypeScript, with no separate DSL or generation step.
- ➕ Lighter runtime, closer to SQL, better for complex queries.
- ➖ **No ready session storage adapter** — the `SessionStorage` interface
  (five or six methods) would have to be implemented by hand.
- ➖ Less mature migration tooling.

**Decision: Prisma.**

The deciding factor is **the official session storage adapter, not Prisma being
the better tool**. Session storage holds OAuth tokens: a mistake there breaks the
whole app and fails in non-obvious ways. On a limited time budget that is the last
place to write custom code in place of something vendor-maintained.

Drizzle would be preferable if the adapter existed, if runtime weight were
critical, or if the project had a lot of complex SQL. None of those hold.

## Decision 3 — the queue

BullMQ + Redis were the original plan. Rejected: a second datastore for a single
low-volume queue is unjustified complexity and one more service to deploy.

**Decision:** a `jobs` table in the same PostgreSQL database. Jobs are claimed
with `SELECT ... FOR UPDATE SKIP LOCKED` inside a transaction, via `$queryRaw`
(Prisma cannot express `SKIP LOCKED`), with a mandatory comment explaining why
raw SQL is used there. Retries and `attempts` are columns; the DLQ is a status,
not a separate table.

BullMQ + Redis move to roadmap v2, for when real load appears.

## Consequences

- One storage service instead of two; the project starts with two commands.
- "Webhook accepted, job enqueued" is transactional for free: both writes go to
  the same database in one transaction. With Redis this would be a distributed
  problem.
- Exactly one place with raw SQL, which requires a comment and a test.
- The schema can be written without regard for SQLite's limitations: `enum`,
  arrays and `jsonb` are all available.

## When to revisit

- The table-based queue stops keeping up (sustained throughput above roughly
  50 jobs/sec, or noticeable row contention) → BullMQ + Redis.
- More than one app instance appears → revisit the worker strategy; it currently
  runs inside the app process (see ADR-0008).
