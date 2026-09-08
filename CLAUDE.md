# CLAUDE.md — repository rules

Context for AI agents working in this repository. Keep it current: a stale file
is worse than no file.

## Project

A reusable foundation for Shopify client work: an Online Store 2.0 theme, an
embedded admin app, and an integration layer for external inventory systems.

NORDLYS is the reference implementation used to exercise the base end to end,
running on a development store. Code written here is meant to be reused across
projects, so it is held to production standards: no shortcuts that would have to
be unwound later, and every non-obvious decision recorded in an ADR.

## Repository state

Updated 2026-09-08.

Present: `theme/` (Dawn-based, phase 1 closed), `apps/admin-app/` (Express +
React), `packages/shared/`, `prisma/` with its migrations, the pnpm workspace at
the root, and `docs/`.

Phases 2 and 3 are both written. The admin app carries OAuth with offline and
online tokens, store preparation, the bundle index and editor, the catalog
export, the sync log, and cost-aware Admin GraphQL. The integration layer
carries webhook intake (`webhook-router.ts`, `webhook-verify.ts`), the queue and
its reaper (`queue.ts`), the in-process worker (`worker.ts`) and the job
handlers (`job-handlers.ts`). The schema is `Session`, `Bundle`, `BundleItem`,
`WebhookDelivery` and `Job`, in three migrations.

What "written" does not mean: **neither phase has been verified against a live
store.** The app has never been opened in a Shopify admin, so no webhook has
arrived from Shopify and no install has run end to end. Everything below that
line is exercised by tests, including integration tests against a real
PostgreSQL. Treat the roadmap's per-item status as authoritative and do not
describe this repository as production-proven.

Not present yet: `services/mock-erp` (roadmap v2), which is what would enqueue
`inventory.push` jobs — the handler, the mutation and its idempotency key exist
and are tested, but nothing in production code produces that kind, so it is
enqueued by hand today (ADR-0017). `extensions/` exists locally as an empty
placeholder; the theme app extension itself is roadmap v2.

Paths referenced in the rules below describe the **target structure** where they
do not exist yet, and are created as work proceeds. A rule pointing at a file
that does not exist yet is a rule to apply once it does. **If a rule requires
reading a file that is missing, say so instead of improvising** — a missing file
is never a licence to guess.

## Stack

- Theme: Liquid, Dawn-based, vanilla JS (web components). Do not add libraries.
- App: TypeScript strict, Node 24, Express (`@shopify/shopify-app-express`, not
  Shopify's app template — ADR-0002), React, App Bridge, and **Polaris web
  components** from Shopify's CDN. Not `@shopify/polaris`: that package is
  deprecated and unmaintained — ADR-0015.
- Data: PostgreSQL + Prisma. Queue: a table in the same database
  (`FOR UPDATE SKIP LOCKED`), no Redis. Rationale in ADR-0007.
- Tests: Vitest + supertest. E2E: Playwright.
- Package manager: pnpm only — not npm, not yarn.

## Hard rules

1. **API version.** The Admin API version is a code-level compatibility
   contract, not environment configuration: it lives in
   `packages/shared/src/api-version.ts` and nowhere else. Never hardcode it inline, never read it from an env var, and
   never take it from model memory — confirm the current stable version through
   the Shopify Dev MCP. The pinned version is **2026-07**; rationale and upgrade
   trigger in ADR-0009.
2. **Always handle `userErrors`.** Any GraphQL mutation can return 200 and still
   not apply. Code that ignores `userErrors` does not pass review.
3. **Webhooks.** Verify the HMAC against the raw `Buffer` before JSON parsing,
   using `crypto.timingSafeEqual`. Deduplicate on `X-Shopify-Webhook-Id`.
   Respond 200 before doing any work; the work goes to the queue.
4. **Rate limits.** Any loop of Admin API calls must read
   `extensions.cost.throttleStatus` and back off with jitter. For hundreds of
   objects or more, use bulk operations rather than paginating in a loop.
5. **No secrets in code.** Only `process.env`, validated with zod at startup.
   `.env` is gitignored; `.env.example` is committed.
6. **Do not break the theme.** Never edit `theme/assets/*.min.*`. App
   functionality reaches the theme through a theme app extension, not the
   Asset API.
7. **Liquid:** use `{% render %}`, not `{% include %}`.
8. **Section schemas** must include `presets`, otherwise the section is
   unavailable in the theme editor.
9. **Queue.** Claim a job with `SELECT ... FOR UPDATE SKIP LOCKED` via
   `$queryRaw`: Prisma cannot express `SKIP LOCKED` in its query API. That call
   site must carry a comment stating this reason, or it reads as unmotivated
   raw SQL.
10. **Idempotency belongs in the database, not in application code.** Webhook
    deduplication is a unique index plus `ON CONFLICT DO NOTHING`. Checking
    "does this row already exist?" with a separate `SELECT` before `INSERT` is
    a race condition and does not pass review.
11. **Prisma migrations, never `db push`.** Every schema change lands as a
    migration file in the repository.

## Commands

Development happens on Windows. The examples below are POSIX shell (Git Bash);
in PowerShell an environment variable is `$env:SHOPIFY_STORE`, not
`$SHOPIFY_STORE`.

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter admin-app dev

docker compose up -d          # local PostgreSQL
pnpm prisma migrate dev

shopify theme dev --path theme --store $SHOPIFY_STORE
shopify theme check --path theme
shopify theme push --path theme --unpublished   # stable preview URL
```

## Definition of Done for any task

- `pnpm typecheck && pnpm lint && pnpm test` all green.
- Theme changes: `shopify theme check` clean, no Lighthouse regression.
- New webhook handler: an HMAC test and an idempotency test.
- Any architectural choice: an ADR in `docs/adr/`.
- The PR states what changed, why, and how it was verified, with a screenshot
  for UI changes.

This list is authoritative. `docs/development.md` repeats it for human
onboarding; if the two ever disagree, this one wins.

## Boundaries for AI agents

**Allowed:** generating code, tests and documentation; refactoring; proposing
architectural options; reading any code in the repository.

**Not allowed:**
- Sending `.env` contents, tokens, keys, or real customer data to a model.
- Inventing Admin API fields or mutations from memory — verify through the
  Shopify Dev MCP.
- Committing generated code without running the tests and reading the full diff.
- Pushing to `main` directly, bypassing a pull request.
- Adding a dependency without recording the reason in the PR.

## How to brief an agent in this repository

Weak: "implement inventory sync."

Strong: "In `apps/sync-worker/src/handlers/inventory.ts`, add a handler for the
`stock.changed` event from the mock ERP. The input schema is in
`packages/shared/src/erp.ts`. Push the update to Shopify via
`inventorySetQuantities` with `name: "on_hand"` — not
`inventorySetOnHandQuantities`, which still exists in the pinned version and is
deprecated in it (ADR-0017). Note that inventory lives on the
InventoryItem × Location pair, not on the variant. Events originating from our
own sync (`syncOrigin === 'nordlys'`) must be skipped — that is an echo, and a
test for it is required. Do not change the public interface of the queue."

The difference is boundaries, input schemas, known domain pitfalls, and an
explicit acceptance criterion.
