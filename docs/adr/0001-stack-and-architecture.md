# ADR-0001: Stack and overall architecture

- **Status:** accepted
- **Date:** 2026-09-07

## Context

The project needs, simultaneously:

- a storefront side: custom Online Store 2.0 sections, bundle assembly, performance;
- a backend side: an embedded admin app, Admin GraphQL, webhooks;
- an integration with an external inventory system.

Constraints: one developer, a limited time budget for the first stage, and a
requirement of explainability — every non-trivial decision must have a reason
recorded either in the code or in an ADR.

## Options considered

### 1. A single app on Shopify's Remix template

- ➕ The official path, with the most provided: OAuth, session storage, webhooks
  out of the box.
- ➕ Fastest route to something working.
- ➖ Less control over the middleware layer; diverges from the project's target
  stack (Express).

### 2. Express + React + Polaris + App Bridge, wired by hand

- ➕ Full control and an exact match to the target stack.
- ➕ Transparent under review: the OAuth flow and session token verification are
  visible rather than implied.
- ➖ More expensive up front: OAuth, session persistence and tunnelling are a
  well-known time sink.

### 3. Headless on Hydrogen plus a separate backend

- ➕ A modern approach with a single TypeScript stack.
- ➖ Triples the scope: the storefront would have to be written from scratch.
- ➖ Solves none of the problems this foundation exists to handle.

## Decision

**Stage 1:** option 1 for the app, plus a custom Dawn-based theme and a separate
Express layer for the webhook receiver and the worker.
**Stage 2:** migrate the app to option 2 (see ADR-0002).

> **Note added 2026-09-07.** The options above concern the app, not the theme
> base: "Dawn-based" was carried into this decision without alternatives being
> listed, and Shopify's Skeleton theme has since become the `theme init` default.
> The base theme choice is argued separately in
> [ADR-0011](0011-dawn-over-skeleton-theme.md), which is authoritative on it.

Monorepo on a pnpm workspace: `theme/`, `apps/`, `extensions/`, `services/`,
`packages/shared/`.

## Rationale

The main risk of the first stage is not architectural but temporal: hand-rolled
OAuth realistically consumes a day while adding nothing to the substance of the
project. What matters here is webhooks, idempotency and rate limit handling — not
a bespoke OAuth implementation whose equivalent is already vendor-maintained.

Express is not decorative in this arrangement: the webhook receiver and the
worker run on it, and that is where the non-trivial logic lives.

Hydrogen was rejected deliberately. Headless is justified by a complex content
layer or multichannel requirements, neither of which this project has. Knowing
when not to reach for a tool is part of the engineering decision.

## Consequences

- Faster to a working result; the risk of losing a day to OAuth is removed.
- The app temporarily does not fully match the target stack — offset by recording
  this explicitly in ADR-0002 with a migration plan, rather than leaving it implicit.
- A monorepo requires workspace and CI setup, but provides shared types and a
  single source of truth for the API version.

## When to revisit

- If migrating to Express takes more than two days, keep the Remix template and
  record that as the final decision rather than leaving a migration half-done.
- If a multichannel requirement appears, reopen the headless question.
