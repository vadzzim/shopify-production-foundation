# ADR-0013: Reveal-on-scroll animations off by default

- **Status:** accepted
- **Date:** 2026-09-08

## Context

Dawn ships a theme setting, `animations_reveal_on_scroll`, on by default. When
it is on, sections receive `scroll-trigger animate--slide-in`, and `base.css`
gives that pair:

```css
.scroll-trigger.animate--slide-in {
  opacity: 0.01;
}
```

`assets/animations.js` then removes `scroll-trigger--offscreen` through an
`IntersectionObserver`, and the element fades in.

This is not a decoration question. The home page's LCP element is the banner
heading — `templates/index.json` sets no image on `image_banner`, so Dawn
renders `placeholder_svg_tag` and the largest painted element is the `<h2>`
inside `.banner__content`. That element carries `scroll-trigger animate--slide-in`.
An element at `opacity: 0.01` is not a paint the browser will count, so LCP
cannot resolve until `animations.js` has parsed, run, and had its observer fire.

Two independent consequences were measured on the preview theme, against the
real Shopify CDN, with Shopify's own preview bar blocked (see
[`docs/performance/README.md`](../performance/README.md) for the harness):

1. **Accessibility.** axe-core reports nine `color-contrast` violations, impact
   *serious*, all in the footer — `#fdfdfd` on `#ffffff`, ratio 1.01:1. The text
   is not miscoloured; it is still at `opacity: 0.01` when the audit runs, and
   axe measures the blended result. Lighthouse's accessibility score is 97 with
   the setting on and 100 with it off. This part is deterministic: it reproduced
   on every run, and the violations disappear if the page is scrolled to reveal
   the footer before auditing.

2. **Performance.** Median of five Lighthouse mobile runs per arm, everything
   else identical: performance 72 with the setting on, 90 with it off; LCP
   5441 ms against 3031 ms.

## Decision

Ship the reusable base with `animations_reveal_on_scroll` set to `false`.

## Consequences

The reveal effect is lost. It is a merchant-facing setting and stays in the
theme editor, so a merchant who wants it can switch it back on — with the
accessibility cost documented here.

Content no longer depends on JavaScript to become visible. With the setting on,
a failure to execute `animations.js` leaves sections permanently at
`opacity: 0.01`: the page renders, the markup is present, and nothing can be
read. That is a worse failure than losing an animation.

## Honesty about the performance number

The performance figure is weaker evidence than the accessibility figure, and the
report says so rather than quoting 72 → 90 as a clean result.

Run-to-run results on this storefront are **bimodal**, in both arms. Runs land
either near LCP 3.0 s or near LCP 5.4 s, with little in between, and the slow
mode also has a slower FCP — roughly 2.8 s against 2.05 s — so it is a
whole-page effect, not something specific to the LCP element. Across all runs
collected, the fast mode appeared in 1 of 8 runs with animations on and 8 of 16
with them off.

So the setting shifts *how often* a load lands in the fast mode; it does not
move every run by 2.4 seconds. The cause of the bimodality is outside the theme:
a home page load issues roughly 300 requests, and the great majority are
Shopify's own platform services — `shop.app/pay/hop`, `login_with_shop`, the web
pixel manager, `otlp-http` telemetry, checkout-web assets. Their latency and
main-thread cost vary more than any theme-level change measured on this day.

The accessibility result carries the decision on its own. The performance result
supports it.

## Alternatives rejected

**Keep the animations and exempt only the first section.** This would preserve
the effect below the fold while freeing the LCP element, and it is what
Shopify's own guidance implies — "don't hide the LCP image behind animations".
Rejected for now because it does not address the accessibility finding at all:
the nine contrast violations are in the *footer*, not the banner, and they would
survive unchanged. It also means editing several Dawn sections to thread a
position condition through, against ADR-0011's reasoning that this base should
keep its diff from stock Dawn small and legible.

**Leave the default alone and document the caveat.** Rejected because the
default produces a page that fails WCAG contrast under automated audit and hides
its own content when one script fails to run. A reusable foundation should not
ship that and delegate the discovery to whoever builds on it.
