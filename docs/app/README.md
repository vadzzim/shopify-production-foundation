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

## `sync-log.png`

The sync log, below the routine sets on the same screen: five queue rows in the
states a merchant will actually meet.

Captured the same way and with the same caveat as `ui-states.png` — real Polaris
web components from `polaris-1.js`, the same markup as
`apps/admin-app/src/web/SyncLog.tsx`, rendered in headless Chrome with fixed
data. It is not a photograph of the Shopify admin, because the app has still
never been opened in one (see the roadmap, and the IPv6 loopback problem in
[`../development.md`](../development.md)).

What the image is there to show:

- **A dead job is not a silent one.** The top row has spent all five attempts
  and will not be retried automatically. It carries the reason Shopify gave —
  `HTTP 503` — and a Retry button, which is phase 3's completion criterion
  rendered: *an external system failure is visible in the UI and can be retried
  manually.*
- **`userErrors` reach the merchant verbatim**, field path and code included, in
  the second row. Rule 2 of `CLAUDE.md` is about not ignoring them; this is what
  not ignoring them looks like at the far end.
- **Retry appears only where it means something.** The pending and succeeded
  rows have no button, and the server refuses a retry for those states
  regardless of what this screen renders.
- **The correlation id is shown, not hidden.** It is Shopify's own delivery id,
  so the grey line under each event is the string that ties this row to every
  log line the delivery produced and to the delivery record in the Partner
  dashboard.
