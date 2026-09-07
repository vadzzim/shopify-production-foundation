# ADR-0014: Keep the cart notification; do not enable the cart drawer

- **Status:** accepted
- **Date:** 2026-09-08

## Context

The Phase 1 accessibility item listed "focus trap in the cart drawer". The
drawer is not enabled: `config/settings_data.json` sets
`cart_type: "notification"`, so `sections/cart-drawer.liquid` never renders and
`cart-drawer.js` never runs. The acceptance criterion named a component the
theme does not currently ship, which left the item unclosable as written.

Two ways out, and leaving the item silently open is worse than either: enable the
drawer, or verify the path the theme actually uses and restate the criterion.

## Decision

Keep `cart_type: "notification"`. Restate the roadmap criterion as focus
management on the add-to-cart path the theme actually renders.

## What was verified, on the live preview theme

Dawn already implements this correctly, and the work was to prove it rather than
to write it:

- `CartNotification.open()` calls `trapFocus(this.notification)` once the open
  transition ends.
- `product-form.js` calls `cart.setActiveElement(document.activeElement)` before
  submitting, recording the button that opened the notification.
- `close()` calls `removeTrapFocus(this.activeElement)`, which focuses that
  element again.

Driven from the product page rather than read from the source: focus moved into
the notification on open (4 focusable elements inside), `Escape` closed it, and
`document.activeElement` afterwards was the original
`button.product-form__submit` — the exact element that triggered the add.

`bundle-builder` does not enter this path at all. It posts to `/cart/add.js`
requesting only `sections: 'cart-icon-bubble'`, so no dialog opens, focus never
leaves the step the customer was on, and the outcome is announced through the
component's own `role="status" aria-live="polite"` region (ADR-0012). There is
nothing to trap and nothing to restore.

## Consequences

The roadmap item becomes "focus moves into the cart notification and returns to
the element that opened it", which is testable against what ships.

If a future project enables the drawer, `cart-drawer.js` has the equivalent
handling — `setActiveElement(triggeredBy)` at line 30 — but it is unverified
here and must be re-tested rather than assumed.

## Alternatives rejected

**Enable the drawer to satisfy the wording.** Rejected: changing a storefront's
cart behaviour to make a checklist item literally true is backwards. The drawer
is a merchant-facing choice about how the store behaves, not an accessibility
improvement — the notification path is already accessible, as measured above.
Enabling it would also load five more render-blocking stylesheets on every page
(`theme.liquid` gates them on `cart_type == 'drawer'`), which the performance
work on this same day was spent removing.

**Leave the item open.** Rejected: an unclosable criterion is a defect in the
roadmap, not a permanent state of the work.
