# ADR-0003: Metaobjects instead of metafields for ingredients

- **Status:** accepted
- **Date:** 2026-09-07

## Context

The NORDLYS storefront has to present the ingredients behind each product, and
the `ingredient-highlights` section (Phase 1) renders them on the product page.

An ingredient is not a loose string. It carries four fields — name, description,
benefit, image — and the same ingredient appears on several products. In the
reference catalog: six ingredients across twelve products, twenty-five
product-to-ingredient links, with each ingredient used by three to six products.

Constraints that shape the decision:

- **The merchant edits this content**, not a developer. It has to be reachable
  and legible in the admin.
- **The theme reads it from Liquid**, without calling our app. Phase 1 ships
  before the app exists at all, so a solution that depends on the app is not a
  solution.
- **The section must be assemblable in the theme editor**, which means the data
  has to be addressable by a stable key rather than positionally.
- ADR-0007 already fixed the principle: *Shopify is the source of truth for
  domain data; our database holds only what Shopify cannot.* Ingredients are
  domain data, so they stay in Shopify.

The question is therefore not *where* the data lives, but *in which Shopify
primitive*.

## Options considered

### 1. Flat metafields per product

One metafield per ingredient slot: `custom.ingredient_1_name`,
`custom.ingredient_1_benefit`, and so on.

- ➕ No new concepts; a definition and a value, nothing else.
- ➖ Every description is stored once per product. Six ingredients over
  twenty-five links means twenty-five copies to keep in step by hand, and they
  will drift.
- ➖ The number of slots is fixed at definition time. A fourth ingredient on one
  product means a schema change for all products.
- ➖ Nothing connects the copies. "Which products use sea buckthorn?" is not a
  question the admin can answer.

### 2. One JSON metafield per product

A single `custom.ingredients` metafield of type `json`, holding an array of
ingredient objects.

- ➕ Variable length; a single definition.
- ➕ Liquid can iterate it directly.
- ➖ **No admin editing to speak of.** The merchant edits raw JSON in a textarea.
- ➖ **The platform validates the wrapper, not the shape.** A renamed key or a
  missing field saves cleanly and the section silently renders nothing. The
  failure surfaces on the storefront, not at edit time.
- ➖ Still one copy per product — option 1's duplication in a different wrapper.
- ➖ Images would have to be URLs, so they escape Shopify's file handling and its
  image transformation filters.

### 3. Metaobject `ingredient` plus a `list.metaobject_reference` metafield

An `ingredient` metaobject definition with typed fields, six entries, and one
product metafield `custom.ingredients` holding an ordered list of references.

- ➕ One entry per ingredient. Editing a description updates every product that
  references it.
- ➕ Fields are typed and validated by the platform, and `image` is a real file
  reference, so the theme gets `image_url` and `srcset` — which Phase 1's
  performance work in ADR-0008's measurement scope depends on.
- ➕ The admin shows the reverse direction: an entry lists what references it.
- ➕ Liquid resolves the list to full objects through `.value` — no second
  lookup, no app call.
- ➖ Two definitions instead of one, and they must be created in order.
- ➖ Storefront access has to be granted on both the metaobject definition and
  the metafield definition. Missing it fails silently (see Consequences).

### 4. Ingredients as products in a hidden collection

Model each ingredient as a product and link with `list.product_reference`.

- ➕ Reuses a primitive already understood, with media and admin UI for free.
- ➖ Pollutes the catalog: inventory, pricing, search, sitemap, and analytics all
  start counting things that are not for sale.
- ➖ A modelling lie. Anything reading products has to learn to exclude these,
  forever, in every consumer.

## Decision

**Option 3.** An `ingredient` metaobject definition (`name`, `description`,
`benefit`, `image`), plus a product metafield `custom.ingredients` of type
`list.metaobject_reference`.

For contrast, the routine step stays a plain metafield:
`custom.routine_step`, `single_line_text_field`, constrained to `cleanse`,
`treat`, `moisturize` by a definition-level validation.

## Rationale

The two decisions above come from the same rule, applied twice:

> A metaobject when the entity is reused across objects and has a structure of
> its own. A metafield when it is an attribute of one object.

An ingredient is reused — three to six products each — and has four fields.
A routine step is used by exactly one product, is a single value, and has no
structure. Putting the step in a metaobject would add indirection with nothing
on the other side of it; putting the ingredient in metafields buys twenty-five
copies of six descriptions.

What tipped option 3 over option 2 specifically was **where errors surface**.
JSON in a metafield is validated as JSON, not as an ingredient: a typo in a key
saves without complaint and shows up as an empty section on the live storefront.
With a metaobject definition the same mistake is rejected at edit time, by the
platform, before anyone sees the page. Choosing the primitive that makes the bad
state unrepresentable is cheaper than writing defensive Liquid.

The routine step validation follows the same logic. Because the definition
restricts the value to three choices, the theme can compare strings directly
instead of normalising input — the check lives in the platform, not in Liquid.

## Consequences

**Easier**

- Ingredient copy is edited in one place and propagates to every product.
- The theme needs no app and no API call: `product.metafields.custom.ingredients.value`
  is a list of resolved metaobjects.
- The data survives app uninstall, consistent with ADR-0007.
- Image fields are real file references, so the section can emit correct
  `srcset`/`sizes` — a prerequisite for the Phase 1 performance targets.

**Harder, and the price paid**

- **Ordering constraint.** The reference metafield cannot be defined before the
  metaobject definition exists. This holds both in the admin and in the app's
  install path.
- ⚠️ **Storefront access is a silent failure mode.** If it is not granted on
  *both* definitions, Liquid resolves the list to nothing, the section renders
  empty, and neither `shopify theme check` nor any log reports a problem. This is
  the single most expensive mistake available in this design, which is a further
  argument for creating the definitions from code rather than by hand: the
  mutation makes the setting explicit, whereas the admin form makes it easy to
  skip.
- The section must tolerate an absent metafield, an empty list, and a reference
  to a deleted entry. Phase 1 treats all three as "render nothing", not as an
  error.
- Per-product ordering of ingredients is the list order and is set by hand. No
  sort key exists on the entry, and adding one would only move the problem.
- Two definitions have to be provisioned. Phase 2 does this at install time via
  `metaobjectDefinitionCreate` and `metafieldDefinitionCreate`, which means
  handling `userErrors` (CLAUDE.md rule 2) and treating "key already taken" as a
  successful outcome rather than a failure, so a reinstall is idempotent.

**Note on scope of this record.** This ADR fixes the choice of primitive and the
requirements on the Phase 2 install path. It deliberately does not write down the
argument structure of those two mutations: the current schema is confirmed
through the Shopify Dev MCP at implementation time, never from model memory
(CLAUDE.md, boundaries for AI agents).

## When to revisit

- **An ingredient needs its own indexable page** (SEO landing per ingredient)
  beyond what a metaobject-backed online store page can express → reconsider the
  primitive, likely in favour of pages or a dedicated content model.
- **An ingredient becomes purchasable** — sold as a refill or a sample. It is a
  product at that point, and option 4 stops being a modelling lie.
- **Per-market ingredient copy** is required and metaobject translation proves
  insufficient for the field set → reopen.
- **The routine step gains structure** — a label, an icon, an ordering weight,
  a description. Two of those and it is an entity, not an attribute, and the rule
  above flips it to a metaobject.
