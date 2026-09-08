# Development

## Requirements

- Node 24 (Active LTS). The version is pinned in `.nvmrc`.
- pnpm
- Docker (or a locally installed PostgreSQL)
- Shopify CLI: `npm i -g @shopify/cli@latest`
- A Shopify Partner account and a development store

## Shell

Development happens on Windows. Commands in this document are POSIX shell
(Git Bash). In PowerShell, read environment variables as `$env:SHOPIFY_STORE`
rather than `$SHOPIFY_STORE`; everything else is the same.

## Getting started

```bash
docker compose up -d
pnpm install
cp .env.example .env
pnpm prisma migrate dev
```

If PostgreSQL is already installed locally, skip Docker and set `DATABASE_URL`
in `.env`.

Then:

```bash
pnpm --filter admin-app dev                # the app
shopify app dev                            # tunnel + install on the dev store
shopify theme dev --path theme --store $SHOPIFY_STORE   # hot reload
```

`shopify app dev` provisions the tunnel itself. The tunnel URL is ephemeral and
is not committed to config — a stable HTTPS URL is only needed for a deployment,
see ADR-0008.

### The app is embedded, so `pnpm dev` alone shows nothing

The server serves both halves on one port: the JSON API under `/api`, and the
React screen. Vite runs as Express middleware in development, so there is no
second dev port — an embedded app is framed at a single URL, and anything on
another origin is unreachable from inside the admin iframe.

Opening `http://localhost:3000/` directly answers **400**. That is correct
behaviour, not a fault: `ensureInstalledOnShop` has no `shop` to check. The app
is only meaningful inside the admin, which needs three things in place:

1. An app in the Partner dashboard, which is what supplies `SHOPIFY_API_KEY` and
   `SHOPIFY_API_SECRET`. `shopify app init` creates one, interactively.
2. `SHOPIFY_APP_URL` set to the tunnel `shopify app dev` prints, with the app's
   URL and callback URL in the Partner dashboard matching it.
3. The scopes in `.env` matching the app's configuration — including
   `read_metaobject_definitions` and `write_metaobject_definitions`, which the
   install step needs to create the `ingredient` metaobject definition.

Store preparation runs by itself after OAuth, on the offline session, and is
idempotent — Shopify's `TAKEN` user error is treated as "already there". The
**Prepare store** button on the bundle screen runs the same code on demand, and
shows what Shopify refused if anything failed.

## Useful commands

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:coverage
pnpm prisma studio                  # database GUI
pnpm prisma migrate dev --name <what_changed>    # never `db push` (rule 11)
pnpm --filter admin-app build       # production browser bundle
shopify theme check --path theme
shopify theme push --path theme --unpublished    # stable preview URL
```

## Development store constraints

- The storefront is always password-protected — a platform constraint, not a setting.
- Real payments are not possible. Test orders go through the Bogus Gateway
  (Settings -> Payments -> test provider).
- Stores are frozen after extended inactivity.

## Git workflow

- Changes land through pull requests only. **The GitHub ruleset that would
  enforce this is not configured yet**, so this is a convention the repository
  follows rather than something the platform prevents. Saying otherwise here
  would be documentation promising a guarantee that does not exist.
- Branches: `feat/bundle-builder`, `fix/webhook-idempotency`, `chore/ci`.
- Conventional commits: `feat(theme): add bundle builder section`.
- A PR states what changed, why, how it was verified, includes a screenshot for
  UI changes, and links the ADR when an architectural decision was involved.

## Definition of Done

- `pnpm typecheck && pnpm lint && pnpm test` all green.
- Theme changes: `shopify theme check` clean, no Lighthouse regression.
- New webhook handler: an HMAC test and an idempotency test.
- Any architectural choice: an ADR in [`adr/`](adr/).
- The PR states what changed, why, and how it was verified, with a screenshot
  for UI changes.

Repeated here for onboarding. [`../CLAUDE.md`](../CLAUDE.md) holds the
authoritative copy; if the two disagree, that one wins.

## Secrets

Only through `process.env`, validated with zod at application startup. `.env` is
gitignored; the current list of variables lives in `.env.example`. CI runs a
secret scan.

Rules for working with AI agents in this repository, including limits on what
data may be shared, are in [`../CLAUDE.md`](../CLAUDE.md) and
[`ai-workflow.md`](ai-workflow.md).
