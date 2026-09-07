# ADR-0010: Section blocks are the card's fields, not the ingredients

- **Status:** accepted
- **Date:** 2026-09-07

## Context

`sections/ingredient-highlights.liquid` renders the ingredients of a product on
the product page. Two requirements meet in it and pull in opposite directions.

From ADR-0003: the content is **data**. It lives in `ingredient` metaobject
entries, referenced from `product.metafields.custom.ingredients`, and each
product references a different set. The theme resolves that list and renders
whatever the product happens to carry.

From CLAUDE.md rule 8 and the Phase 1 completion criteria: the section must be
**assemblable by a merchant in the theme editor** — heading, column count and
block selection — without a developer editing Liquid. A section without
`presets` is not even offered in the editor.

Section blocks are the only editor primitive that gives a merchant ordering and
add/remove control. So the question is what a block *is* in this section, and
the answer is constrained by a fact about the theme editor: **a section on a
product template is shared by every product that uses that template.** Block
settings are stored in `templates/product.json`, not per product. Anything a
merchant puts in a block is therefore identical on all twelve products.

## Options considered

### 1. No blocks — read the metafield, render a fixed card

The section reads the list and renders image, name, benefit and description in a
hardcoded order.

- ➕ Simplest possible Liquid; content stays fully data-driven.
- ➖ Fails rule 8: with no `presets` the section cannot be added in the editor at
  all, and adding `presets` without blocks still leaves the card's composition
  frozen.
- ➖ "Hide the description in this section" becomes a code change and a
  deployment. That is the exact dependency the requirement exists to remove.

### 2. Blocks are ingredient cards, each with a `metaobject` picker

One block per card, carrying a `metaobject` setting of type `ingredient`.

- ➕ Clean editor semantics: one block, one card, one `shopify_attributes`.
- ➕ Works on any template, product page or not.
- ➖ **It contradicts ADR-0003 on the product page.** Because block settings live
  in the template, pinning entries shows the same ingredients on every product.
  The merchant would be re-entering by hand the relationship the metafield
  already stores — twenty-five links reduced to one arbitrary set.
- ➖ The two requirements become mutually exclusive: data-driven means zero
  blocks, and using blocks means abandoning the data.

### 3. Blocks are the card's fields; content comes from the data

Four block types — `image`, `name`, `benefit`, `description` — one per field of
the `ingredient` definition. The section iterates the product's ingredients and
renders each card by walking `section.blocks`, so **block order is field order**
and removing a block removes that field from every card.

- ➕ Both requirements hold at once: the content is per-product data, the
  composition is merchant-controlled.
- ➖ Each block renders once per ingredient, so a block id would appear N times
  in the DOM (addressed below).
- ➖ Block types are tied to the field keys of the metaobject definition: a fifth
  field means a fifth block type in code.

### 4. A theme app extension block

Ship the section as an app block instead of theme code.

- ➕ The merchant inserts it without the theme being edited, and it survives
  theme updates.
- ➖ There is no app. ADR-0003 fixed Phase 1 as shipping before the app exists,
  so this is not available. It is already on the roadmap as `bundle-block`.

## Decision

**Option 3.** Blocks are the anatomy of one card, one block type per field of
the `ingredient` definition, `limit: 1` each and `max_blocks: 4`. `presets`
ships all four in reading order, so the section is usable the moment it is
added.

Two supporting decisions come with it:

- **Source override.** A `metaobject_list` setting (`metaobject_type:
  "ingredient"`) takes precedence over the metafield when it is non-empty,
  otherwise the section falls back to
  `product.metafields.custom.ingredients.value`. This is what lets the section
  be used outside a product page — where `product` is nil and the metafield path
  yields nothing — without option 2's per-product wrongness.
- **Editor attributes on the first card only.** `block.shopify_attributes` is
  emitted when `card_index == 1`. Every block id then appears exactly once in
  the DOM, and the editor still has an element to select and reorder.

## Rationale

Option 2 is the one that looks right and is wrong, so it is worth naming why.
Its appeal is a tidy one-block-one-card mapping. Its defect is that it puts the
product-to-ingredient relationship in the *template*, and a template is shared.
ADR-0003 paid for that relationship deliberately — a metaobject plus a reference
list, precisely so six descriptions are not copied twenty-five times. Option 2
would spend that back and hand the merchant a section that lies on eleven of
twelve products.

Option 3 keeps the two concerns in the layers that own them: **what** is shown
is data, **how** it is shown is theme configuration. That separation is not
invented here — it is how Dawn's own `main-product` section works, where blocks
are title, price, variant picker and description rather than the products
themselves.

The cost is the DOM duplication, and the first-card-only rule resolves it. This
is worth writing down because it looks like an oversight in review: the obvious
reading of "emit `shopify_attributes` on block wrapper elements" is to emit it
everywhere, and doing so produces duplicate block ids that the editor resolves
arbitrarily.

The `metaobject_list` override earns its place for a second reason beyond
non-product pages: it is the only way to exercise the section in the theme
editor without a product context, which makes the three empty states from
ADR-0003 reachable during review rather than only in production.

## Consequences

**Easier**

- Column count, heading, image ratio, alignment and field composition are all
  merchant-controlled. None of them is a deployment.
- Adding an ingredient to a product in the admin changes the storefront with no
  theme change.
- The three states ADR-0003 requires to be silent — metafield absent, list
  empty, every reference deleted — are handled in one place: the section counts
  resolvable entries first and emits nothing at all, not an empty grid and not a
  stranded heading.

**Harder, and the price paid**

- ⚠️ **A `metaobject_list` setting on a custom definition disqualifies the theme
  from the Shopify Theme Store.** Shopify permits only standard metaobject
  definitions there. This is a base for client work, not a Theme Store
  submission, so the constraint is accepted — but any future attempt to list a
  theme built on this base has to drop the setting and lose the override.
- Block types mirror the field keys of the `ingredient` definition. A fifth
  field requires a fifth block type, a `max_blocks` bump and a preset update.
  The coupling is deliberate and shallow, but it is real.
- Selecting a block in the editor highlights the first card, not the field
  across all cards. Correct behaviour, mildly surprising the first time.
- The section reads `product` implicitly, so it renders nothing on a template
  with no product unless the override is set. That is intended, and the setting
  carries an `info` string saying so.

## When to revisit

- **The `ingredient` definition gains or loses a field** → the block list and
  `max_blocks` follow. Mechanical, but it must actually be done, or the new
  field is invisible.
- **The app ships and grows a theme app extension** → option 4 becomes real, and
  the section can move to an app block that survives theme updates. Roadmap v2
  already anticipates this for `bundle-block`.
- **A theme built on this base is submitted to the Theme Store** → the
  `metaobject_list` override has to go, along with the non-product-page use case
  it supports.
- **The merchant needs per-product control of the card composition** — different
  fields shown on different products. Blocks cannot express that, because they
  are per template. It would mean a metafield per product driving the layout,
  which is configuration masquerading as content; the answer is more likely a
  second template than a change here.
