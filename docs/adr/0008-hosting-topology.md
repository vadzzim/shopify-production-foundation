# ADR-0008: Hosting and deployment topology

- **Status:** accepted
- **Date:** 2026-09-07

## Context

Shopify does not host the backend of a custom app — the sole exception is Oxygen,
and that only serves Hydrogen storefronts. Shopify knows exactly one thing about
an app: the HTTPS URL to call.

Where each component actually lives:

| Component | Where | How it gets there | Cost |
|---|---|---|---|
| Theme | Shopify CDN | `shopify theme push` | 0 |
| Theme app extension | Shopify infrastructure | `shopify app deploy` | 0 |
| Checkout UI extension | Shopify infrastructure | `shopify app deploy` | 0 |
| Shopify Function | WASM inside Shopify | `shopify app deploy` | 0 |
| **Embedded admin app** | **external provider** | our deployment | ~$5–10/mo |
| **PostgreSQL** | **external provider** | — | free tier |

So only the app and the database require external hosting.

## Constraints Shopify imposes

1. **A stable HTTPS URL** with a valid certificate, recorded in
   `shopify.app.toml`. Changing the URL means editing config and running
   `shopify app deploy`. Tunnels (`cloudflared`, ngrok) are for local development
   only.
2. **Always on.** Webhooks arrive at any time and Shopify's timeout is a few
   seconds. A free tier that sleeps after idling produces cold starts of up to a
   minute and failed deliveries.
3. **Respond 200 fast**, moving the work to a queue. This is what removes any
   dependence on geographic proximity to Shopify (see below).
4. **Persistent storage.** A PaaS filesystem is ephemeral: a file-based database
   is wiped on redeploy, along with the OAuth tokens.

## Latency: what matters and what does not

Three legs, and only one is critical:

1. **App → Admin API.** Irrelevant. There is no "next to Shopify" to deploy into:
   it is global infrastructure, and a shop's data region is tied to the shop and
   not selectable. These calls are background work; tens of milliseconds do not
   matter.
2. **Shopify → our webhooks.** Almost irrelevant — **provided we return 200 fast
   and queue the work.** If the handler works synchronously, the problem is the
   pattern, not the geography.
3. **App ↔ database.** ⚠️ **The only critical one.** App and database in different
   regions add ~100 ms per query, multiplied by the number of queries per render.

**Rule: app and database in the same region; nothing else matters.**

## Options considered

### 1. Fly.io + Neon Postgres, single region (EU)

- ➕ Always on, region selection, stable domain, ~$5–10/mo.
- ➕ The worker runs in the same process — the table-based queue allows this.
- ➖ Costs money and one to two hours of setup.

### 2. Render free tier

- ➖ **Sleeps web services after roughly 15 minutes idle**, with cold starts up to
  a minute. Unacceptable for an app that must be reachable at any time.

### 3. Serverless (Vercel / Lambda)

- ➕ Cheap and scalable.
- ➖ Connection pooling to Postgres from functions; no place for a long-running
  worker. Two new classes of problem with no gain against the project's goals.

### 4. Local runtime plus video, theme on a Shopify preview URL

- ➕ Zero cost, zero setup.
- ➕ **The storefront is still reachable by link** — the preview theme is hosted by
  Shopify, permanently and without sleeping.
- ➖ The app cannot be opened without running it locally.

## Decision

**Option 4 at the current stage. Option 1 once permanent external access to the
app is required.**

- Theme → `shopify theme push --unpublished`. The one part of the project
  reachable at a stable link, and it is free.
- App and PostgreSQL → local; demonstration via video.
- `Dockerfile` and `fly.toml` are real and committed. The deployment is ready to run.
- The worker runs inside the app process — the table-based queue allows it;
  extracting it into its own service is roadmap v2.

## Rationale

**An embedded admin app cannot be opened by link under any hosting arrangement.**
It only works inside a specific store's admin, and a deployed version still
requires app installation or collaborator access. Deployment therefore does not
make the app more accessible — it only moves where it runs.

Deployment also costs one to two hours **after** the app is written and affects
none of the project's goals. So it is deferred rather than dropped: `Dockerfile`
and `fly.toml` are working, the topology is recorded here, and execution happens
when needed.

## Consequences

- The README states explicitly that the app runs locally and links to this ADR;
  without that, the absence of a deployment reads as an omission rather than a
  decision.
- Video is the primary way to show the app working to anyone not running it locally.
- `docker-compose.yml` is mandatory: the project must start for anyone who clones
  the repository.
- In local development, webhooks arrive through the `shopify app dev` tunnel. That
  URL is ephemeral and is not committed to config.

## When to revisit

- External access to the app becomes necessary (asynchronous review over several
  iterations, a demonstration without the author present) → execute option 1.
- A second app instance appears → revisit where the worker runs; it currently
  lives inside the app process.
