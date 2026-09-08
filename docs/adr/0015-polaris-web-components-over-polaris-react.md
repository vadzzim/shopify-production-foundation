# ADR-0015: Polaris web components, not Polaris React

- **Status:** accepted
- **Date:** 2026-09-08

## Context

`CLAUDE.md` names Polaris in the stack. In 2026 that word points at two
different things, and only one of them is maintained.

Checked against the npm registry on 2026-09-08, `@shopify/polaris` 13.9.5 —
Polaris React, the package almost every tutorial installs — carries a
deprecation notice from Shopify:

> Polaris React is deprecated and no longer maintained. For building Shopify
> admin experiences, use Polaris web components

The replacement is not an npm package. Polaris web components are custom
elements (`s-page`, `s-table`, `s-banner`, …) registered by a script loaded from
Shopify's CDN, alongside the App Bridge script the app already needs. Types come
from `@shopify/polaris-types`, which is types only — nothing ships in the
bundle.

Two versions of that script are published: `polaris-1.js`, a channel that
follows the newest stable Polaris 1 release and is what Shopify recommends for
production, and `polaris-1.1-rc.js`, the release candidate. They are not
equivalent — the 1.1 candidate has components 1.0 does not, `s-empty-state`
among them. That was verified by reading the tag names out of both bundles, not
by reading the documentation, because shopify.dev serves the 1.1 reference by
default and its examples silently assume the candidate.

## Options considered

### 1. `@shopify/polaris` (Polaris React)

- ➕ The largest component set, and the one every example and every answer on
  the internet is written against.
- ➕ Ordinary React components: no custom-element interop to think about.
- ➖ Deprecated by its own publisher and no longer maintained. New code written
  on it starts in debt, and the debt grows on its own.
- ➖ Shopify's newer admin surfaces are wired to the web components, so the React
  package falls further behind rather than standing still.
- ➖ It is a real dependency in the bundle, and a large one.

### 2. Polaris web components from Shopify's CDN

- ➕ The supported path, and the one the deprecation notice names.
- ➕ Nothing enters the bundle: the components come from the same CDN as App
  Bridge, and the admin's own version of them stays in step with the admin
  around the iframe.
- ➕ Usable directly in JSX. React 19 passes props to custom elements properly,
  and `@shopify/polaris-types` declares them as intrinsic elements, so they are
  typechecked.
- ➖ A smaller component set at 1.0. There is no `s-empty-state` and no skeleton
  component, so an empty state is composed from `s-section`, `s-stack`,
  `s-heading` and `s-button`, and the loading state uses `s-table`'s own
  `loading` attribute.
- ➖ Much less written material than Polaris React, and what exists on
  shopify.dev documents the 1.1 candidate.
- ➖ Two more requests on first paint, though both are CDN-cached across every
  app the merchant opens.

### 3. No component library

- ➕ Total control, no dependency at all.
- ➖ An embedded app that does not look like the admin reads as broken rather
  than as bespoke.
- ➖ The admin's styling changes under us, and we would be chasing it forever.
- ➖ Accessibility would be ours to get right, in a surface where Shopify has
  already got it right.

## Decision

**Option 2, on the stable channel:**
`https://cdn.shopify.com/shopifycloud/polaris-1.js`.

## Rationale

Installing a package whose own registry entry says it is unmaintained, into a
repository written to production standards, is not a trade-off — it is a defect
with a plausible excuse. The familiarity argument for Polaris React is real, and
it is worth less than being on the surface Shopify is actually developing.

Between the two channels, stable wins for the same reason ADR-0009 chose a
stable API version over the release candidate: a candidate takes
backwards-incompatible changes without notice, and this repository does not ship
against those. The price is one hand-composed empty state.

## Consequences

- The empty state in `apps/admin-app/src/web/App.tsx` is built from primitives.
  That is deliberate, and it is recorded here so nobody "fixes" it by switching
  the script tag to the release candidate.
- There is no skeleton component. `s-table`'s `loading` attribute is the
  platform's answer, and it is what the screen uses.
- Polaris is not in `package.json`, which means `pnpm outdated` will never
  mention it. The version is a URL in `index.html`; upgrading channels is an
  edit there, and it is the kind of change that needs a deliberate look at the
  screen afterwards.
- The components are unavailable outside the Shopify admin, so the UI cannot be
  rendered by a plain unit test. Behavioural coverage of the screen belongs to
  Playwright in phase 4; until then the API beneath it is what the tests cover.

## When to revisit

- Polaris 1.1 goes stable. That brings `s-empty-state` and skeleton components,
  and the hand-composed empty state should be replaced with the real one in the
  same change that moves the channel.
- Shopify publishes a React wrapper over the web components. That would remove
  the interop question without returning to the deprecated package.
