# ADR-0012: One Ajax add for a bundle, all-or-nothing enforced by the theme

- **Status:** accepted
- **Date:** 2026-09-07

## Context

`sections/bundle-builder.liquid` lets a customer pick one product per routine
step — cleanse, treat, moisturise — and put the whole routine into the cart. The
line items have to be recognisable later as one bundle: a discount function
(roadmap v2) prices them together, and the sync layer has to see an order line
as part of a set rather than as three unrelated purchases.

Two properties are therefore required, and they are not the same requirement:

1. **The lines are linked.** A private line item property `_bundle_id`, the same
   value on every line of one bundle. Private, because a key beginning with `_`
   is hidden from the customer in the cart and at checkout while remaining
   readable in Liquid, in the Ajax API, in the order, and by a function.
2. **The lines arrive together.** A cart holding two thirds of a routine is
   worse than a cart holding none: the customer sees an incomplete set, and the
   bundle discount does not apply because its condition is not met. A partial
   result is a wrong result, not a smaller one.

What Shopify documents about `POST /cart/add.js`, confirmed through the Shopify
Dev MCP rather than from memory:

- Several variants can be added in one request through the `items` array, each
  entry carrying its own `properties` object — that is where `_bundle_id` goes.
- Bundled section rendering (`sections`, `sections_url`) works on `/cart/add`,
  so up to five sections can be re-rendered from the same response. This is how
  the header cart count stays truthful with no second round trip.
- Cart errors come back as HTTP 422 (`"already sold out"`, `"You can't add
  more"`) or 404 (`"Cannot find variant"`) with a `status` field in the body.
  They resolve the fetch promise like a success, so failing to inspect the body
  means reporting success for an empty cart.
- **Whether a multi-line add is atomic is not documented.** The error shapes are
  specified; what happens to the other lines when one of them fails is not.

That last gap is the decision. Everything else follows from the documentation.

## Options considered

### 1. One request per product

Three sequential calls to `/cart/add.js`, generating `_bundle_id` client-side
and passing it to each.

- ➕ Trivial error attribution: the failing call names its own product.
- ➖ Three round trips before the customer sees anything, and the cart count
  ticks up in between.
- ➖ **Partial state is not an edge case but the normal failure mode.** A failure
  on the third call always leaves two orphaned lines, so a rollback is needed
  anyway — with a wider window in which a customer can navigate away with a
  broken cart.

### 2. One request, trusting the platform's rejection semantics

Send the `items` array, and on 422/404 show a message and assume nothing landed.

- ➕ No rollback code, one request.
- ➖ Correctness rests on undocumented behaviour. If a multi-line add is not
  atomic, the customer is told "nothing was added" while two lines sit in the
  cart — the worst of the possible outcomes, because it is silent.
- ➖ Undocumented behaviour is not a contract. It can change without a version
  bump, and a theme is not versioned against the Ajax API at all.

### 3. One request, all-or-nothing enforced by the theme

Send the `items` array. On any failure, `GET /cart.js`, collect the line item
keys whose `properties._bundle_id` matches the id just generated, and zero them
in a single `POST /cart/update.js`.

- ➕ The guarantee holds under either platform behaviour, so no bet is placed.
- ➕ `_bundle_id` — which exists for the discount — is exactly the marker the
  rollback needs. The clean-up cannot touch a line the customer added earlier,
  even the same variant, because the id is generated per click.
- ➖ On an atomic rejection the extra `GET` finds nothing and the code appears
  to do nothing. It is dead weight until the day it is not.
- ➖ Two extra requests on the error path.

### 4. Storefront API cart mutations

Build the bundle through `cartLinesAdd` instead of the Ajax API.

- ➕ Documented error semantics per line (`userErrors`), and one mutation can
  create a cart with several lines.
- ➖ **A different cart.** The Storefront API cart is not the theme's cart
  session; the theme's `cart` object, the header count and `/cart` would not see
  it without adopting the Storefront cart across the whole theme.
- ➖ A public access token in the theme and an extra round trip for data already
  present in Liquid.
- Storefront API is the right answer when the cart lives outside the theme
  (headless), or when data is needed that Liquid does not expose. Neither is
  true here.

### 5. The bundle as a single purchasable product

A bundle product whose components are the three items, via Shopify's bundles
functionality.

- ➕ One line item, atomic by construction, priced as a unit.
- ➖ The customer's choice is the feature. Four products per step means 64
  combinations, each needing a variant or a product — the catalog would encode
  the UI.
- ➖ Requires an app (a product-bundles function). Phase 1 ships before the app
  exists, which ADR-0003 already fixed as a constraint.

## Decision

**Option 3.** One `POST /cart/add.js` carrying every line with the same
`_bundle_id`, `sections: 'cart-icon-bubble'` for the header count, and a
theme-side rollback keyed by that id if the response is anything other than a
clean success.

Supporting decisions taken with it:

- **Errors are classified by status, not by string matching.** 422 → sold out or
  insufficient stock; 404 → the variant no longer exists in the online store;
  a rejected promise → the network. Each maps to its own sentence in
  `locales/en.default.json`. Shopify's own `description` is displayed as a
  second line, because it names the product that failed and a translated
  sentence cannot.
- **A step whose products are all sold out removes the button.** That case is
  known at render time, so the section does not offer a control that is
  guaranteed to fail. The 422 path covers the remaining window — stock running
  out between page render and click.
- **Blocks are steps.** This is the opposite answer to ADR-0010, and the reason
  is the same test: a block's settings live in the template, so blocks may only
  hold what is genuinely the same for every page rendering that template. On the
  product page in ADR-0010, ingredient references failed that test — they are
  per-product data. Here, "step one draws from the `cleanse` collection" is
  template-level configuration by nature, so blocks are the right home for it
  and each block renders exactly once, with no need for ADR-0010's
  first-card-only `shopify_attributes` workaround.
- **Steps are driven by collections, not by the `routine_step` metafield.** The
  automated collections already encode that condition, one Liquid call resolves
  a step's products, and a merchant can point a step somewhere else without
  code. Filtering `collections.all.products` by metafield in Liquid would hit
  the 50-iteration limit and hardcode the three allowed values in the theme.

## Rationale

The choice between options 2 and 3 is a choice about what to do with an
undocumented behaviour, and it is worth naming the asymmetry rather than the
probability. A multi-line add is, on the balance of evidence, atomic — but the
two ways of being wrong are not comparable. Trusting it and being right saves
two requests on a path the customer rarely reaches. Trusting it and being wrong
produces a cart that contradicts the message on screen, with no way for the
customer to know and no way for us to find out except from a support ticket.
Verifying it costs a `GET` on the error path.

The rollback is also the reason the id is generated per click rather than per
session or per section: it makes "the lines belonging to this attempt" a precise
set. A session-scoped id would make the clean-up unable to distinguish this
attempt from a bundle the customer added five minutes ago.

The choice of Ajax over the Storefront API is not about capability. Both can add
three lines. It is about which cart the customer is looking at: the theme
renders `cart`, the header renders `cart.item_count`, `/cart` renders the same
object. Using a Storefront cart alongside those would put two carts in one
storefront, and the visible one would be the wrong one.

## Consequences

**Easier**

- The bundle is one request and one user-visible outcome. There is no state in
  which the customer has to be told which part of the routine went through.
- `_bundle_id` is now the join key for the whole feature chain: the discount
  function reads it from the cart line, the order webhook reads it from the
  order line, the sync layer groups by it. None of those exist yet, and none of
  them needs the theme to change when they do.
- Every failure is a sentence in a locale file, so translating the feature is a
  translation job rather than a code change.
- The section keeps its dependency on Dawn down to three classes —
  `page-width`, `color-<scheme>`/`gradient` and `button` — after ADR-0011 noted
  how diffuse `ingredient-highlights`'s dependency turned out to be. Everything
  else it draws is in `assets/section-bundle-builder.css`, and the component's
  strings travel inside the section instead of being appended to the theme's
  global `cartStrings`.

**Harder, and the price paid**

- ⚠️ **The rollback path is hard to exercise.** Under atomic behaviour it does
  nothing, so it is code that review cannot see working. It is commented at the
  call site with the reason it exists, which is the only defence against a
  future reader deleting it as unreachable.
- The section requires JavaScript. A no-JS fallback would have to submit a form
  to `/cart/add` without `_bundle_id` — an unlinked bundle that looks added and
  is not discounted. The button therefore ships `disabled` and is enabled by the
  component, with a `<noscript>` sentence explaining why.
- One product per step, one variant per product: the option value is
  `selected_or_first_available_variant`. A step over multi-variant products
  would need a variant picker per option, which is a different feature.
- The bundle total is not shown. Summing prices client-side means formatting
  money in JavaScript, which needs the shop's money format and its edge cases;
  showing it server-side is impossible because the selection is client-side.

## When to revisit

- **Shopify documents the atomicity of a multi-line add** → if it is guaranteed,
  the rollback becomes provably dead and should be deleted, with this ADR
  superseded rather than quietly contradicted.
- **The discount function ships** → it becomes the consumer of `_bundle_id`, and
  the property's format stops being an internal detail of the theme. That is the
  point at which its shape is worth pinning in `packages/shared`.
- **The cart drawer is enabled** (`cart_type` is `notification` today) → the
  section currently re-renders only `cart-icon-bubble`; a drawer would want its
  own sections in the same `sections` parameter, up to five.
- **A bundle needs to be one line item** — a fixed set at a fixed price rather
  than a customer-assembled one → that is option 5, and it needs the app.
- **Steps stop being collections** — a step over a product's own related items,
  say → the block setting changes shape, and the argument in the Decision for
  collections over the metafield has to be re-run.
