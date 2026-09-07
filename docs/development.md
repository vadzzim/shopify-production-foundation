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

## Useful commands

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm prisma studio                  # database GUI
shopify theme check --path theme
shopify theme push --path theme --unpublished    # stable preview URL
```

## Development store constraints

- The storefront is always password-protected — a platform constraint, not a setting.
- Real payments are not possible. Test orders go through the Bogus Gateway
  (Settings -> Payments -> test provider).
- Stores are frozen after extended inactivity.

## Git workflow

- `main` is protected: changes land through pull requests only.
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
