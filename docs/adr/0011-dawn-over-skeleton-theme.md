# ADR-0011: Dawn over the Skeleton theme as the base for stage 1

- **Status:** accepted
- **Date:** 2026-09-07

## Context

ADR-0001 fixed "a custom Dawn-based theme" as part of the stack, and CLAUDE.md
repeats it as a hard rule. That record is incomplete: it was written before
Shopify's Skeleton theme became the default starting point, so the option that
is today Shopify's own recommendation does not appear in its list of
alternatives. The decision has an outcome but not an argument.

This surfaced while scaffolding the theme on day 2. `shopify theme init` in CLI
4.7.1 no longer clones Dawn — it clones `Shopify/skeleton-theme` unless
`--clone-url` says otherwise. Skeleton shipped in May 2025 as "a minimal,
carefully structured Shopify theme designed to help you quickly get started",
and the current "Create a theme" tutorial uses it. That is new information about
platform direction, and CLAUDE.md permits reopening an ADR on new information.
Dawn was cloned explicitly at the time, because the rule said Dawn; the decision
this record settles is whether that rule should stand now that the alternative
is the platform default.

Measured, not recalled — both repositories cloned and counted on 2026-09-07:

| | Skeleton | Dawn (as vendored here) |
|---|---|---|
| Files | 53 | 354 |
| Lines | 2,294 | 134,066 |
| JavaScript files | **0** | ~40 |
| `blocks/` (theme blocks) | `group`, `text` | none |
| Ajax cart | none | `product-form.js`, `cart-notification.js`, `cart-drawer.js` |
| `window.routes` / `customElements` / `fetch` | absent entirely | the basis of the cart layer |
| Cart implementation | `<form method="post">` to `/cart`, full page reload | fetch plus Section Rendering API |

The constraint that decides it: the next task in the plan is the bundle builder
— three products added in a single `/cart/add.js` request with a `_bundle_id`
line item property, plus visible handling of sold-out, unavailable-variant and
network failures. That task is entirely an Ajax cart task.

## Options considered

### 1. Dawn

- ➕ The cart layer already exists and is the documented reference
  implementation: shopify.dev still points at Dawn's cart template and sections
  as the example to follow. `product-form.js` is a working model of the exact
  pattern the bundle builder needs — `fetchConfig`, `sections` plus
  `sections_url` on the request, sections re-rendered from the response.
- ➕ Matches the reality of client work. A foundation meant to be reused across
  Shopify projects meets Dawn and Dawn derivatives far more often than a theme
  built from Skeleton.
- ➕ Gives the stage 1 performance work something to measure. Removing unused
  Dawn CSS and JS is a real optimisation with a real before and after, and it is
  work clients actually commission.
- ➖ 134,066 lines of vendor code in the repository. Our own contribution is a
  needle in it, mitigated only by keeping the import in its own commit.
- ➖ No `blocks/` directory, so theme blocks — the newer, more reusable
  primitive — are not available without adding them by hand.
- ➖ It is no longer what the CLI or the getting-started tutorial hands you,
  which dates the choice.

### 2. Skeleton

- ➕ Shopify's current recommended starting point and the CLI default.
- ➕ Ships theme blocks, which is where the architecture is going, and would let
  ADR-0010's field blocks become theme blocks — genuinely more reusable.
- ➕ 2,294 lines. Everything in the repository would be ours, and the
  performance baseline would be about our code rather than someone else's.
- ➖ **Zero JavaScript.** No `fetch`, no `customElements`, no `window.routes`,
  and the cart is a plain form POST with a full page reload. The entire Ajax
  cart layer — route wiring, request, section re-rendering, the notification UI
  — would have to be written before the bundle builder could start.
- ➖ The day 2 section would have to be rewritten. It leans on Dawn's `grid`,
  `media--<ratio>`, `rte`, `page-width`, `color-scheme` and `title-wrapper`
  classes and on the shared `t:sections.all.*` schema translations. Skeleton has
  almost no CSS, so all of that becomes ours to write.
- ➖ Realistically a day and a half to two days on top of the plan, against a
  hard stop at day 8.

### 3. Horizon

Shopify's new flagship theme, already present unpublished on the dev store.

- ➕ The most current architecture of the three, and the storefront events
  documentation now treats Horizon-style and Dawn-style cart components as the
  two recognised shapes.
- ➖ Not offered by `theme init` as a starting point, and heavier than Skeleton
  without Dawn's status as the documented reference implementation. It answers
  neither the "minimal and modern" nor the "batteries included" case cleanly.

## Decision

**Option 1 — Dawn — for stage 1.** Migration to Skeleton plus theme blocks goes
to roadmap v2 as a designed but unexecuted item, alongside the other extension
points.

## Rationale

The honest comparison is not "which theme is more modern" but "which one lets
the next four days happen". Skeleton is the better long-term base and the better
signal of current practice. It is also a theme with no JavaScript in it, and the
next task is an Ajax cart. Choosing it now would mean spending the bundle
builder day building the cart infrastructure that the bundle builder sits on,
and then still having the bundle builder to write.

Two further points, weighed and not decisive:

Skeleton would make the repository honest in a way Dawn does not — 2,294 lines
of ours against 134,066 lines of someone else's. That is a real cost of Dawn and
the reason the vendor import is isolated in a single commit, so the diff of our
own code can be read on its own.

Against that, the stage 1 performance work needs headroom to demonstrate. On
Skeleton the before-and-after would be close to flat, because there is almost
nothing to remove. On Dawn there is unused CSS and JavaScript to strip, and that
is both measurable and representative of the work.

What this record does **not** claim is that Dawn is the better base in general.
It is the better base for a nine-day stage whose third day is a cart. Stated
that narrowly, the decision survives; stated as a general preference, it would
not.

## Consequences

**Easier**

- Day 3 starts from a working Ajax cart rather than from an empty `assets/`
  directory.
- Dawn's classes and shared schema translations keep new sections short: the day
  2 section needed 39 lines of its own CSS because the grid, media box and rich
  text styling came from the base.
- Shopify's own documentation doubles as documentation for our base, since it
  uses Dawn for its examples.

**Harder, and the price paid**

- The repository carries 134,066 lines it did not write. Every future reader has
  to be told which commit is the vendor import.
- Theme blocks are unavailable without hand-rolling them, so ADR-0010's field
  blocks stay section blocks and are usable only inside their own section.
- The base dates from the moment Skeleton became the default. Anyone reviewing
  this work will notice, which is the reason this record exists rather than
  leaving the choice to look unexamined.
- Upgrading Dawn later is a manual three-way merge against `258f00f`, because
  the clone's own history was dropped.

## When to revisit

- **Stage 1 ends.** Roadmap v2 is the natural point to rebase the foundation on
  Skeleton, port the sections, and convert the field blocks to theme blocks. The
  cart layer written on day 3 is the piece that would carry over.
- **A client project starts on Skeleton or Horizon.** The base then has to match
  the client's theme, and the reusable parts of this foundation should not
  assume Dawn's class names. That is an argument for keeping section CSS
  self-contained from here on.
- **Dawn stops receiving updates.** It is currently maintained, but the moment
  Shopify's own reference examples move off it, its main advantage — being the
  documented implementation — is gone.
- **Theme blocks become required** for something in scope, such as an app block
  that has to nest into our sections.
