# ADR-0002: Express with `@shopify/shopify-app-express`, not Shopify's app template

- **Status:** accepted
- **Date:** 2026-09-08

## Context

[ADR-0001](0001-stack-and-architecture.md) left this open deliberately. It chose
Shopify's default app template for stage 1 and recorded a stage 2 migration to
Express, on one stated ground:

> hand-rolled OAuth realistically consumes a day while adding nothing to the
> substance of the project

Meanwhile `CLAUDE.md` declares the stack as **Express, React, Polaris, App
Bridge**, and the app is the one part of the repository that did not match it.
This ADR closes that gap, in one direction or the other.

Two facts, both checked against the npm registry on 2026-09-08 rather than
recalled:

**The template is no longer a Remix template.** `@shopify/shopify-app-remix` is
at 5.0.1 and has been superseded by `@shopify/shopify-app-react-router` (2.1.0),
which is what the CLI scaffolds and what shopify.dev documents. "Take the default
template as it comes" no longer means what it meant when ADR-0001 was written.

**Express is on the same release train.** These were all published on
2026-08-28, from one repository:

| Package | Version |
|---|---|
| `@shopify/shopify-app-express` | 8.0.1 |
| `@shopify/shopify-app-remix` | 5.0.1 |
| `@shopify/shopify-app-react-router` | 2.1.0 (2026-09-01) |
| `@shopify/shopify-app-session-storage-prisma` | 10.0.1 |
| `@shopify/shopify-api` | 14.0.1 |

That second fact is the one that matters, because it makes ADR-0001's premise
false. `shopifyApp()` from `@shopify/shopify-app-express` supplies OAuth begin
and callback, session token verification, session storage, the embedding CSP
header and the install check. None of it is hand-rolled; it is the same vendor
code the React Router package wraps, behind a different adapter. The day
ADR-0001 was protecting is not on the table.

One practical constraint shaped the timing but not the decision: `shopify app
init` is interactive — organisation, name and template are chosen at a prompt —
so the template path cannot be taken without a person at a terminal, while the
Express path is ordinary code.

## Options considered

### 1. `shopify app init`, React Router template as it comes

- ➕ The official happy path. Every guide on shopify.dev is written against it.
- ➕ Most provided: routing, OAuth, session storage, webhook registration,
  Polaris wiring and a Vite setup, all scaffolded.
- ➕ New Shopify capabilities land here first.
- ➖ Diverges from the stack `CLAUDE.md` declares, so either the app or the rule
  has to change.
- ➖ Scaffolds its own project shape, which then has to be fitted into a pnpm
  workspace that already has `theme/`, `packages/shared/` and a root Prisma
  schema.
- ➖ The framework hides the boundary this project exists to demonstrate.
  `authenticate.admin(request)` inside a loader is one call; the middleware chain
  it stands for is what a reviewer of this repository should be able to read.
- ➖ Phase 3 needs Express anyway for the webhook receiver and the worker
  (ADR-0001), so this keeps two frameworks in one repository.
- ➖ Template updates arrive as a diff against a scaffold, not as a dependency
  bump.

### 2. Express with `@shopify/shopify-app-express`

- ➕ Matches the declared stack exactly; `CLAUDE.md` becomes descriptive rather
  than aspirational.
- ➕ The same vendor OAuth implementation, maintained on the same release train.
- ➕ One framework for the app, the webhook receiver and the worker.
- ➕ The authentication path is legible: five middleware lines in `app.ts` say
  what protects what.
- ➖ We own the parts the template would have given: the HTML shell, the Vite
  middleware, static asset serving. In this repository that is about 130 lines of
  `apps/admin-app/src/server/app.ts`.
- ➖ Shopify's documentation leads with React Router. Answers need translating,
  and a feature that ships as a React Router package first would have to be
  wired by hand.

### 3. Both: the template for the UI, Express for webhooks

- ➕ Each half on the framework its documentation assumes.
- ➖ Two HTTP servers, two authentication setups, two dependency trees, one
  deployment. The seam between them becomes a permanent maintenance surface.
- ➖ Every future decision has to be made twice.

## Decision

**Option 2.** `@shopify/shopify-app-express` 8.0.1, with Vite running as Express
middleware in development so that the API and the embedded UI share one origin.

## Rationale

ADR-0001 traded stack fidelity for a day of OAuth work. That day does not exist:
the Express adapter is a first-class, currently-maintained package, and the
authentication code is vendor-supplied either way. What is actually being chosen
is which framework wraps that vendor code — and one of the two candidates is
already required for phase 3.

The secondary argument is about what this repository is for. It is a foundation
that has to be explainable: someone reviewing it should be able to point at the
line that verifies a session token. A template that answers "the framework does
it" is the right answer for shipping an app quickly and the wrong one here.

What is being paid for that is real and small: the document shell and the asset
pipeline. What is being avoided is a second framework in a repository that will
run an Express worker regardless.

## Consequences

- Roadmap v2's "Migrating the app to Express" item is closed by doing it now
  rather than deferring it, and is removed from the roadmap.
- Shopify's guides need translating from React Router to Express. The adapter's
  own README covers the middleware, but examples on shopify.dev generally will
  not match.
- `shopify app dev` still works — it provisions the tunnel and updates the app
  URL — but this app is not template-shaped, so anything the CLI expects to
  rewrite inside a scaffold does not apply.
- Token exchange stays off. The Express adapter exposes it as
  `future.tokenExchange`, and it requires Shopify managed installation; the app
  uses the authorization code flow until that is configured deliberately.
- If this turns out to be wrong, the ported surface is `app.ts`, `shopify.ts` and
  `api-router.ts`. The parts with the actual domain logic — store setup, bundle
  assembly, throttling, `userErrors` handling — take no framework dependency and
  move unchanged.

## When to revisit

- `@shopify/shopify-app-express` misses two consecutive releases of the train
  above. That would be the signal that Express has become a legacy adapter, and
  it is a fact worth checking rather than assuming.
- A Shopify capability the project needs ships as a React Router package with no
  framework-neutral equivalent.
