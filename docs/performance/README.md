# Performance measurements

## Methodology

- Lighthouse CLI, 3 runs, median reported — a single run is too noisy.
- Mobile and desktop measured separately; mobile is the priority.
- Page under test: the product page with the bundle builder (the heaviest one).
- The baseline was captured on unmodified Dawn with identical content, otherwise
  the comparison would not be honest.

## Results

| Metric | Before | After | Delta |
|---|---|---|---|
| LCP (mobile) | | | |
| CLS | | | |
| INP | | | |
| TBT | | | |
| Performance score | | | |
| Accessibility score | | | |

## What moved the needle

Each optimisation is a separate commit with its own measurement: otherwise there
is no way to tell which change produced the effect.

| Change | Commit | Effect on LCP |
|---|---|---|
| Preload the LCP image | | |
| srcset/sizes via image_url | | |
| Defer scripts, drop unused Dawn assets | | |
| Reserve dimensions for media | | |
| font-display: swap + preconnect | | |

## What did not help

Changes that produced no measurable effect are recorded here too, so they are
not reapplied out of habit.

## Accessibility

- axe report: `axe-report.json`
- Verified manually: keyboard navigation through the bundle builder, focus trap
  in the cart drawer, `aria-live` on add-to-cart, colour contrast.

## Reports

- `before-mobile.report.html` / `after-mobile.report.html`
- `before-desktop.report.html` / `after-desktop.report.html`
