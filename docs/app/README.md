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

## `bundle-editor.png`

The routine set editor, opened on a set whose products no longer match the slots
they are in, with the activation refused.

Captured the same way and with the same caveat as the two above: real Polaris
web components from `polaris-1.js`, the same markup as
`apps/admin-app/src/web/BundleEditor.tsx`, rendered in headless Chrome with
fixed data. Not a photograph of the Shopify admin.

- **The refusal names every slot at once**, in Shopify's terms rather than ours:
  which product, what its `custom.routine_step` actually says, and why the
  storefront would not show it. A merchant fixing three slots one round trip at
  a time is a worse experience than being told all three.
- **The catalog checks belong to activation, not to editing.** A draft is a
  workspace — half-finished sets, products not published yet — and this same
  form saves all of that without complaint as long as the status stays draft.
- **Delete is in the footer, not in the table.** It switches this modal's body
  to a confirmation rather than opening a second one: Polaris modals do not
  nest, and a page-level confirmation would sit further from the action that
  raised it.

### A trap for the next stand

`s-select` **ignores a `value` written as an HTML attribute.** The element
upgrades before its `<s-option>` children have been parsed, finds nothing to
match, and falls back to the first option — so a hand-written stand renders the
wrong selection and nothing warns you. Assigning the property after
`customElements.whenDefined('s-select')` works.

This is a property of static HTML, not of the app: React sets `value` as a
property on a custom element whose class is already defined, and `polaris-1.js`
is a blocking script in `index.html` while `main.tsx` is a module, so it is
always defined first. The stand had to do by hand what `BundleEditor.tsx` gets
for free. It was found by looking at the first screenshot, which is the argument
for taking screenshots at all.

## `catalog-report.png`

The Catalog section: what a finished bulk export says about the store.

Same capture method, same caveat. The numbers are fixed, chosen to show the
three things the report exists for:

- **A step with no products at all** is badged, because that is exactly the
  condition "Create routine set" refuses on. Reading it here is cheaper than
  pressing the button to find out.
- **Products with no routine step** are counted and a few are named. The report
  is a dated document rather than a cache — nothing renders live catalog state
  from it — which is what makes naming products acceptable
  ([ADR-0004](../adr/0004-bulk-operations-over-pagination.md)).
- **A misspelled step is the case nothing else can show.** A product whose
  metafield reads `moisturise` is absent from every other screen in this app and
  from the storefront section, because both filter on the exact choice-list
  value. This banner is the only place a merchant can discover it.
