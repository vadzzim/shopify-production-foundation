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

#### Shopify CLI owns `shopify.app.toml`

Worth knowing before editing it: `shopify app config link` **rewrites the file
wholesale**. Comments are deleted, keys are reordered, and two values are
replaced with the CLI's own idea of them:

- **`[webhooks] api_version` is reset to the CLI's latest**, which on
  2026-09-08 meant `2026-10` — a release candidate, which
  [ADR-0009](adr/0009-admin-api-version.md) refuses precisely because
  release candidates take backwards-incompatible changes without notice. A
  webhook registered at one version and parsed by code written for another is
  the bug rule 1 exists to prevent.
- **`[auth] redirect_urls` is derived**, and the CLI wrote `/api/auth` rather
  than this app's callback path. During `shopify app dev` it updates the
  dashboard from `auth_callback_path` in `shopify.web.toml`, so OAuth still
  works, but the committed file ends up describing something else.

The guard is a test: `packages/shared/src/api-version.test.ts` reads the TOML
and fails when `api_version` no longer matches the pinned constant. **If
`pnpm test` starts failing on that assertion, the CLI repinned the version** —
set it back to `2026-07` rather than updating the test.

`client_id` is committed. It is public — the same value the browser receives as
`SHOPIFY_API_KEY` — and the CLI writes it into this file regardless, so keeping
it out is a fight with the tool rather than a security measure. Starting a
client project from this base means running `shopify app config link` and
letting it be replaced.

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
shopify app dev --tunnel-url=https://<host>:443                    # own tunnel
shopify app dev                          # just retry; the failure is often transient
```

Two details about `--tunnel-url` that each cost a failed run to discover:

- **The port is required**, even when it is the implicit one. A bare
  `https://host` is rejected with `Valid format: "https://my-tunnel-url:port"`,
  so an HTTPS tunnel URL needs `:443` spelled out.
- **The tunnel is yours to point somewhere.** The CLI does not manage it, and it
  assigns the app process a random port unless told otherwise — which would
  leave the tunnel forwarding to nothing. `apps/admin-app/shopify.web.toml`
  pins `port = 3000`, so the tunnel should forward to 3000.

Any tunnel provider works: ngrok, pinggy, a Cloudflare named tunnel. Free tiers
usually rotate the hostname, which costs nothing here —
`automatically_update_urls_on_dev = true` means each `shopify app dev` run
rewrites the app URL and callback URL in the dashboard to whatever tunnel it was
given.

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

##### `Localhost certificate and key are required at .shopify/localhost.pem`

The CLI is supposed to fetch mkcert into `.shopify/` and issue the certificate
itself. When it cannot — the download goes to GitHub, so a network that blocks
the Cloudflare tunnel often blocks this too — the two files have to be made by
hand. Names are not negotiable; they are what the CLI looks for.

```bash
scoop install mkcert          # or: winget install FiloSottile.mkcert
mkcert -install
mkcert -cert-file .shopify/localhost.pem -key-file .shopify/localhost-key.pem localhost 127.0.0.1 "::1"
```

`mkcert -install` adds a local root CA to the system trust stores, so it is a
deliberate step to run yourself rather than something to automate away.

**It is also not optional here.** The app is loaded in an iframe, and a browser
does not offer the "proceed anyway" interstitial inside one — an untrusted
certificate shows up as an empty or blocked frame with no explanation, which
reads as a broken app rather than as a certificate problem. Under WSL, mkcert
installs the CA into Linux only and the Windows browser keeps rejecting it until
the root CA is added on the Windows side; Shopify's
[networking options](https://shopify.dev/docs/apps/build/cli-for-apps/networking-options)
page has those steps.

`.shopify/` is gitignored, so these files stay local — as they should, being a
certificate and its private key.

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

## Webhooks and the queue

The app receives webhooks at `POST /api/webhooks`, verifies the signature
itself, records the delivery, queues the work, and answers 200 before any of
that work runs. Why it verifies the signature itself rather than using
`shopify.processWebhooks()` is [ADR-0016](adr/0016-webhook-ingestion.md).

### Subscriptions live in `shopify.app.toml`

They are app-specific: declared once in the config file and applied by Shopify
to every store that installs the app. Nothing subscribes through the Admin API,
deliberately — see the ADR.

Consequence worth remembering: **a change to `[[webhooks.subscriptions]]` reaches
a store on `shopify app deploy`, not on a code deploy.** `shopify app dev`
applies it to the linked development store while it runs.

Adding a topic is three edits, and the tests fail until all three agree:

1. `WEBHOOK_TOPICS` in `packages/shared/src/jobs.ts`
2. `JOB_KIND_BY_TOPIC` in `apps/admin-app/src/server/webhook-router.ts`
3. `[[webhooks.subscriptions]]` in `shopify.app.toml`

### Trying it without Shopify

A delivery is a signed POST, so `curl` can produce one. The signature is a
base64 HMAC-SHA256 of the **exact bytes** of the body, keyed with
`SHOPIFY_API_SECRET`:

```bash
BODY='{"id":1,"name":"#1001"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SHOPIFY_API_SECRET" -binary | base64)
curl -i -X POST http://127.0.0.1:3000/api/webhooks   -H 'Content-Type: application/json'   -H "X-Shopify-Hmac-SHA256: $SIG"   -H 'X-Shopify-Topic: orders/create'   -H 'X-Shopify-Shop-Domain: ecorn-oj1cb5ll.myshopify.com'   -H 'X-Shopify-API-Version: 2026-07'   -H 'X-Shopify-Webhook-Id: local-test-1'   --data-raw "$BODY"
```

Send it twice with the same `X-Shopify-Webhook-Id`: the second answers
`{"status":"duplicate"}` and queues nothing. Change one character of the body
without re-signing and it answers 401.

`printf`, not `echo` — `echo` appends a newline, which changes the bytes and
therefore the signature. That is the same class of mistake the receiver's tests
hit when they first sent bodies through superagent.

### Watching the queue

The worker runs inside the app process (ADR-0008) and polls every two seconds.
Jobs are rows in `Job`:

```bash
pnpm prisma studio                  # look at Job and WebhookDelivery
```

A failed job is also visible in the app itself, in the sync log below the
routine sets, with the reason and a Retry button.

### Reading the logs

Logging is pino, so the output is JSON, and every line a delivery causes carries
the same `correlationId` — Shopify's own `X-Shopify-Webhook-Id`. That is what
ties an HTTP request to work the worker does minutes later, possibly after a
restart:

```bash
pnpm dev | npx pino-pretty                       # readable output
pnpm dev | grep '"correlationId":"local-test-1"' # one delivery, end to end
```

`pino-pretty` is deliberately not a dependency: as a transport it runs a worker
thread and can lose lines on exit, and piping gets the same result outside the
process.

## Useful commands

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:coverage
pnpm prisma studio                  # database GUI
pnpm prisma migrate dev --name <what_changed>    # never `db push` (rule 11)
pnpm prisma migrate deploy          # apply existing migrations, what CI runs
pnpm --filter admin-app build       # production browser bundle
shopify theme check --path theme
shopify theme push --path theme --unpublished    # stable preview URL
```

### Tests that need a database

Most of the suite runs against fakes. Three files do not, and cannot: the
guarantees they check — `ON CONFLICT DO NOTHING` making a duplicate webhook a
no-op, and `FOR UPDATE SKIP LOCKED` handing one job to exactly one of two
workers — are properties of PostgreSQL, and a mocked Prisma would only confirm
that the method we meant to call was called.

Those files (`*.integration.test.ts`) **skip themselves when `DATABASE_URL` is
unset**, so `pnpm test` is green on a fresh clone with nothing running. To
actually run them:

```bash
docker compose up -d
pnpm prisma migrate deploy
pnpm test
```

CI sets `DATABASE_URL` and runs a `postgres:16-alpine` service, so they do run on
every pull request. If a change to the queue passes locally and fails in CI,
this is why: locally they were skipped.

They write only to shops prefixed `itest-` and clean up after themselves, so they
will not disturb data for the real development store in the same database.

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
