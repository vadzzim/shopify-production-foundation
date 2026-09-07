# ADR-0009: Admin API version pinned to 2026-07

- **Status:** accepted
- **Date:** 2026-09-07

## Context

Every Admin API call, every webhook subscription and every GraphQL validation run
executes against one specific API version. Shopify versions are date-based, ship
quarterly at the start of the quarter, and each stable version is supported for at
least 12 months with at least nine months of overlap between consecutive versions.

Verified through the Shopify Dev MCP on 2026-09-07 — not taken from model memory,
per the rule in `CLAUDE.md`:

| Version | Released | Accessible until | Status on 2026-09-07 |
|---|---|---|---|
| 2026-01 | 2026-01-01 | 2027-01-16 | stable, older |
| 2026-04 | 2026-04-01 | 2027-04-16 | stable, older |
| **2026-07** | **2026-07-01** | **2027-07-16** | **current stable** |
| 2026-10 | 2026-10-01 | 2027-10-16 | release candidate |

Source: [About Shopify API versioning](https://shopify.dev/docs/api/usage/versioning).

Two properties of the platform make this a decision worth recording rather than a
configuration detail.

**Falling forward is silent.** If a request targets a version that is no longer
accessible, Shopify does not return an error — it serves the request using the
oldest accessible stable version. An app that has drifted past its version's
support window keeps working until a behavioural difference produces wrong data,
with nothing in the response to indicate why. The `X-Shopify-API-Version` response
header is the only signal, and only if something reads it.

**Release candidates can change under you.** The RC for the next version becomes
available on the same day the current stable ships. Shopify adds both
backwards-compatible *and* backwards-incompatible changes to an RC before it
stabilises, and explicitly recommends against using RCs in production.

## Decision 1 — which version

### `unstable`

- ➕ Access to features before anyone else.
- ➖ Changes without notice, including breaking changes. Nothing built on it can be
  trusted to still work tomorrow.

### 2026-10 (release candidate)

- ➕ Would avoid a version bump three weeks from now, when it goes stable on
  2026-10-01.
- ➕ The longest runway: accessible until 2027-10-16.
- ➖ Breaking changes can still land in it before the stable release, and we would
  absorb them in working code rather than in one deliberate upgrade.
- ➖ Shopify recommends against RCs in production, and this repository is written to
  production standards even while NORDLYS runs on a development store.

### 2026-07 (current stable)

- ➕ Fixed contract: no changes will be introduced into it.
- ➕ Ten months of runway (until 2027-07-16) — more than the project needs before its
  first planned upgrade.
- ➕ Matches the Dev MCP default, so documentation lookups and schema validation
  describe the same version the code calls.
- ➖ Costs one deliberate upgrade when we eventually move to a newer version.

**Decision: 2026-07.**

The case for 2026-10 was avoiding an upgrade three weeks out. That is a real saving,
but it buys a smaller cost with a worse one: an RC can take a backwards-incompatible
change at any point before 2026-10-01, and we would meet it as a bug in running code
instead of as a scheduled migration. Ten months of runway on a frozen contract is
worth more than three weeks of deferred work. Deciding *when* to upgrade is
something we should keep, not something the calendar should take from us.

## Decision 2 — where the value lives

### Whatever the SDK defaults to (no explicit pin)

- ➕ Nothing to maintain.
- ➖ The version then changes when a dependency is updated. A `pnpm update` becomes a
  silent API contract change, which is precisely the class of failure that has no
  visible cause.

### An environment variable

- ➕ Different environments could target different versions.
- ➖ The version is a **compile-time compatibility contract**, not deployment
  configuration: the GraphQL documents in the repository are written against the
  fields and mutations of one specific version. Making it an env var creates a
  combination — old code, new version — that nothing typechecks and nothing tests.
- ➖ A wrong value fails at runtime, in production, silently (see fall-forward).

### A constant in `packages/shared/src/api-version.ts`

- ➕ One place. Changing it is a code change, so it goes through review and CI.
- ➕ The value is available to the app, the worker and the theme app extension from
  a single import, with no duplication to drift.
- ➖ Requires a deploy to change — which is the point, not a drawback.

**Decision:** a single exported constant in `packages/shared/src/api-version.ts`.
No inline version strings, no env var, no value taken from model memory.

Webhook subscriptions carry their own version and must be registered against the
same constant. A webhook registered at a different version than the code that
parses its payload is the same class of bug, arriving through a different door.

## Consequences

- Upgrading is one edit plus a full test run, rather than a search across the
  repository for hardcoded strings.
- Shopify Dev MCP calls should pass `version: "2026-07"` explicitly. The validation
  tool's version enum accepts `2026-10` and `unstable`, so relying on its default
  leaves open the possibility of validating our code against an RC schema and getting
  a pass for a field that does not exist in the version we actually call.
- Any GraphQL document added to the repository is valid only against 2026-07.
  Validation output from another version is not evidence about our code.
- Nothing yet enforces this. The constant does not exist because implementation has
  not started; a lint rule banning inline version strings is worth adding once
  `packages/shared` exists.

## When to revisit

- **Hard deadline: 2027-04.** That leaves a full quarter before 2026-07 stops being
  accessible on 2027-07-16, so the upgrade is never done under time pressure.
- 2026-10 goes stable on 2026-10-01. That is a trigger to *evaluate*, not to bump:
  upgrade then only if it carries something we need.
- A Shopify changelog entry announcing a breaking change to metaobjects (ADR-0003),
  inventory, or bulk operations in a version we intend to move to.
