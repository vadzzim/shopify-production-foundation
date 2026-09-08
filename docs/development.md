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

### The app is embedded: `http://localhost:3000` will never show it

`No shop provided` with a 400 is the install check working, not a fault. The
server serves both halves on one port — the JSON API under `/api` and the React
screen, with Vite as Express middleware — because an embedded app is framed at a
single URL and anything on another origin is unreachable from inside the admin
iframe. Opened directly there is no `?shop=`, so `ensureInstalledOnShop` has
nothing to check, and even with one the browser would refuse to frame an
`http://` page inside the HTTPS admin as mixed content.

So the app needs an app record in the dashboard and an HTTPS tunnel. Shopify CLI
provides both.

#### First time: link the app

**Do not run `shopify app init`.** It scaffolds a *new* project from Shopify's
React Router template — see [ADR-0002](adr/0002-express-over-the-app-template.md)
for why this app is not that — and in this repository it would build a second
app beside the real one.

`shopify.app.toml` and `apps/admin-app/shopify.web.toml` are already written.
What is missing is the `client_id`, which identifies one app in one
organisation. `config link` creates or picks the app and fills it in:

```bash
shopify app config link
```

#### Every time: run it

```bash
docker compose up -d          # the database still has to be up
shopify app dev
```

`shopify app dev` opens the tunnel, updates the app URL and callback URL in the
dashboard (`automatically_update_urls_on_dev = true`, because the tunnel URL is
ephemeral), runs `pnpm dev` in `apps/admin-app`, and prints a link that installs
the app on the store you choose.

**It also supplies the credentials.** The CLI injects `SHOPIFY_API_KEY`,
`SHOPIFY_API_SECRET`, `HOST` (the tunnel URL), `SCOPES` and `PORT` into the app
process. `HOST` and `SCOPES` are this project's `SHOPIFY_APP_URL` and
`SHOPIFY_SCOPES` under Shopify's names, mapped in
`apps/admin-app/src/server/cli-env-aliases.ts`. So for this path **`.env` needs
only `DATABASE_URL`** — and putting the scopes in `.env` as well is actively
worse, because `[access_scopes]` in `shopify.app.toml` is what the merchant
granted and a disagreement puts the app in a scope-update loop.

#### When the Cloudflare tunnel will not start

`shopify app dev` opens a Cloudflare Quick Tunnel by default, and it fails on
some networks with `Could not start Cloudflare tunnel: max retries reached`.
That is a connectivity problem between the machine and Cloudflare, not a problem
with the app — `config link` having succeeded is the proof, since the app,
organisation and dev store were all resolved before the tunnel was attempted.

Three ways forward, in the order worth trying:

```bash
shopify app dev --use-localhost          # no tunnel at all
shopify app dev --tunnel-url=https://<your-ngrok>.ngrok-free.app   # own tunnel
shopify app dev                          # just retry; the failure is often transient
```

**`--use-localhost` is the right default for this project today.** The CLI
serves the app over `https://localhost:3458` with a certificate it generates
itself through mkcert, and runs a TLS reverse proxy on that port which forwards
to the app — so the Express server keeps serving plain HTTP on whatever port the
CLI assigns, and `HOST` arrives as `https://localhost:3458`. Needs Shopify CLI
3.80 or newer, and `--localhost-port` overrides the port.

The catch is what localhost cannot reach: Shopify features that **call the app**
rather than being called by it — webhooks, app proxy, Flow actions — and
anything tested from another device, such as POS. Today that costs nothing,
because the webhook receiver is phase 3 and no subscriptions are declared. From
phase 3 onwards this option stops being enough and a real tunnel is required;
that is the point at which `--tunnel-url` with ngrok, or a working Cloudflare
tunnel, becomes mandatory rather than a preference.

On first run mkcert may ask to install its root certificate into the Windows
trust store. Under WSL it installs into Linux only, and the Windows browser then
shows a certificate error until the root CA is added manually — Shopify's
[networking options](https://shopify.dev/docs/apps/build/cli-for-apps/networking-options)
page has the steps.

#### Running the server without the CLI

`pnpm --filter admin-app dev` starts the same server, and then every variable in
`.env.example` is yours to set, including a tunnel URL you provide and keep in
step with the dashboard by hand. Useful for reading logs against a tunnel you
control; the CLI path is shorter for everything else.

#### What should happen on a successful install

Store preparation runs by itself after OAuth, against the shop's **offline**
token, and is idempotent — Shopify's `TAKEN` user error is treated as "already
there". Look for this in the server output:

```
INFO  Store prepared for <shop>.myshopify.com
```

If it is absent, the definitions were not created; the **Prepare store** button
on the bundle screen runs the same code on demand and shows what Shopify
refused. On `ecorn-oj1cb5ll` everything already exists, so every line of the
report should read `already_present` — a store where it reads `created` is a
store that was genuinely missing them.

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
