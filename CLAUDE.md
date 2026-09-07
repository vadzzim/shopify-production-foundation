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

## Stack

- Theme: Liquid, Dawn-based, vanilla JS (web components). Do not add libraries.
- App: TypeScript strict, Node 20, Express, React, Polaris, App Bridge.
- Data: PostgreSQL + Prisma. Queue: a table in the same database
  (`FOR UPDATE SKIP LOCKED`), no Redis. Rationale in ADR-0007.
- Tests: Vitest + supertest. E2E: Playwright.
- Package manager: pnpm only — not npm, not yarn.

## Hard rules

1. **API version.** Always use the current stable Admin API version defined in
   `packages/shared/src/api-version.ts`. Never hardcode a version inline, and
   never take one from model memory — verify it through the Shopify Dev MCP.
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

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter admin-app dev

docker compose up -d          # local PostgreSQL
pnpm prisma migrate dev
pnpm prisma studio            # database GUI

shopify theme dev --store $SHOPIFY_STORE
shopify theme check --path theme
shopify theme push --unpublished   # stable preview URL for the theme
```

## Definition of Done for any task

- `pnpm typecheck && pnpm lint && pnpm test` all green.
- Theme changes: `shopify theme check` clean, no Lighthouse regression.
- New webhook handler: an HMAC test and an idempotency test.
- Any architectural choice: an ADR in `docs/adr/`.
- The PR states what changed, why, and how it was verified, with a screenshot
  for UI changes.

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
`inventorySetOnHandQuantities`. Note that inventory lives on the
InventoryItem × Location pair, not on the variant. Events originating from our
own sync (`syncOrigin === 'nordlys'`) must be skipped — that is an echo, and a
test for it is required. Do not change the public interface of the queue."

The difference is boundaries, input schemas, known domain pitfalls, and an
explicit acceptance criterion.
