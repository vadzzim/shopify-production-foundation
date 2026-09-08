# Admin app — screens

## `ui-states.png`

The bundle index in its three states: empty (a fresh install), loaded, and
failed after a mutation returned HTTP 200 with `userErrors`.

**How it was captured, and what that means.** These are the Polaris web
components from `polaris-1.js` — the same components and the same markup as
`apps/admin-app/src/web/App.tsx` — rendered in Chrome from a static page with
fixed data, not photographed inside the Shopify admin. The reason is that
opening the app in an admin requires an app in the Partner dashboard and a
tunnel, and both of those are created by interactive Shopify CLI commands
(`shopify app init`, `shopify app dev`).

So this shows what the components do; it does not prove the app installs. Those
are different claims and the roadmap keeps them apart: the phase 2 completion
criterion is explicitly marked as not yet verified.

Three details in the image are worth reading rather than skipping:

- The **empty state is composed from primitives** — `s-section`, `s-stack`,
  `s-heading`, `s-button` — because Polaris 1.0 has no `s-empty-state`. It
  arrives in the 1.1 release candidate, which this app does not load. See
  [ADR-0015](../adr/0015-polaris-web-components-over-polaris-react.md).
- The second row shows a product whose GID is stored here but which the Admin
  API no longer returns — deleted in Shopify. The cell says **Removed** instead
  of a name we last saw weeks ago.
- The error banner carries the `userErrors` entry verbatim, field path and code
  included. Shopify's wording is the only description of what it refused, so it
  is passed through rather than replaced with "something went wrong".
