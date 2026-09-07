# Performance and accessibility measurements

Captured 2026-09-08 on the NORDLYS reference store. Every number here comes from
a run recorded in [`runs.json`](runs.json); nothing is quoted from memory or
from a single run.

## Where this was measured, and what that cost

**Page under test:** the home page (`templates/index.json`) — banner, then
`bundle-builder`, then `featured-collection`. It carries the section this stage
built and is the heaviest template in the theme.

**Target:** the theme pushed unpublished to the Shopify CDN, measured through the
real storefront. Not a local `shopify theme dev` server: the CLI injects
`theme-hot-reload.js` and proxies assets through localhost, so TBT, LCP and
request counts there are not production numbers.

Three things about this setup are not obvious and change how the numbers should
be read.

**A development store is always password-protected.** That is a platform
restriction, not a setting — it cannot be switched off until the store moves to
a paid plan. Lighthouse launches its own Chrome and inherits no browser session,
so without a cookie it measures the password page and reports a beautiful score
for the wrong document. The cookie is passed with `--extra-headers`.

The cookie is **`_shopify_essential`**, not `storefront_digest`. Shopify changed
this; the older name no longer appears at all. The preview theme selection is
baked into the same cookie — visiting `?preview_theme_id=…` returns a rotated
`_shopify_essential` that carries both the password grant and the theme choice,
which is why the measured URL is plain `/` with no redirect in the trace.

**Lighthouse writes `extraHeaders` into the report it generates.** All four
committed HTML reports were scrubbed before being committed; the cookie value
now reads `REDACTED`. Anyone repeating this must check the same thing — the leak
is silent.

**Shopify's preview bar is excluded** via
`--blocked-url-patterns='*shopifycloud/preview-bar*'`. It loads only because the
theme under test is unpublished, and it is not small: 183 KB of vendor JS, 97 KB
of CSS, 75 KB of app JS. It also injects an untitled `<iframe>`, which costs a
`frame-title` violation that is not the theme's. Leaving it in would have
flattered nothing and slandered everything: with the bar included the same
baseline scored **51** on mobile instead of 73, and accessibility 93 instead of
97.

**Method:** Lighthouse CLI 13.4.1, five runs per configuration, median reported.
The per-optimisation runs early in the day used three; where that mattered the
measurement was repeated with five, and the text says so.

**INP is absent on purpose.** It is a field metric; a Lighthouse lab run cannot
produce one. TBT is the lab proxy and is reported instead. Claiming an INP from
a lab run would be inventing a number.

## Results

Median of five runs, home page. "Before" and "after" differ by the three commits
on this branch.

### Mobile

| Metric | Before | After | Delta |
|---|---|---|---|
| Performance score | 72 | **90** | +18 |
| Accessibility score | 97 | **100** | +3 |
| LCP | 5441 ms | **3031 ms** | −2410 ms |
| FCP | 2518 ms | 2068 ms | −450 ms |
| Speed Index | 4609 ms | 2817 ms | −1792 ms |
| TBT (lab proxy for INP) | 159 ms | 137 ms | −22 ms |
| CLS | 0.000 | 0.000 | — |
| Total transfer | 1726 KB | 1720 KB | −6 KB |

### Desktop

| Metric | Before | After | Delta |
|---|---|---|---|
| Performance score | 99 | 98 | noise |
| Accessibility score | 97 | **100** | +3 |
| LCP | 793 ms | 913 ms | noise |
| Speed Index | 1142 ms | 916 ms | −226 ms |
| TBT | 28 ms | 0 ms | −28 ms |
| CLS | 0.000 | 0.000 | — |

Desktop had no performance headroom to recover — it was at 99 before any change.
The accessibility gain is real on both form factors; the performance gain exists
only where the main thread is slow. That asymmetry is explained below and is the
most useful thing on this page.

## What moved the needle, one change at a time

### Reveal-on-scroll animations off — the whole performance result

`animations_reveal_on_scroll` gives sections
`.scroll-trigger.animate--slide-in { opacity: 0.01 }` until `animations.js`
reveals them through an `IntersectionObserver`.

The home page's LCP element is the banner `<h2>` — `image_banner` has no image
set, so Dawn renders `placeholder_svg_tag` and the largest paint is text. That
`<h2>` sits inside `.banner__content`, which carries the animation class. An
element at `opacity: 0.01` is not a paint the browser counts, so LCP could not
resolve until the observer fired.

Measured as a clean A/B, five runs per arm, nothing else changed:

| | Animations on | Animations off |
|---|---|---|
| Performance (mobile) | 72 | 90 |
| LCP (mobile) | 5441 ms | 3031 ms |
| Accessibility | 97 | 100 |
| Performance (desktop) | 99 | 98 |

**How much to trust the mobile figure.** Less than it looks, and the honest
version is this: results on this storefront are **bimodal in both arms**. Runs
land either near LCP 3.0 s or near LCP 5.4 s with little in between, and the
slow mode also has a slower FCP — about 2.8 s against 2.05 s — so it is a
whole-page effect rather than something specific to the LCP element. Across
every run collected, the fast mode appeared in **1 of 8** runs with animations
on and **8 of 16** with them off.

So the setting changes *how often* a load lands in the fast mode. It does not
move every run by 2.4 seconds, and quoting "72 → 90" without this paragraph
would be overselling it.

The cause of the bimodality is outside the theme. A home page load issues
roughly **300 requests**, and the overwhelming majority are Shopify's own
platform services — `shop.app/pay/hop`, `login_with_shop/authorize`, the web
pixel manager, `otlp-http` telemetry, checkout-web assets. Their latency varies
run to run by more than any theme change measured today. Server response time
for the document itself was a steady 19–20 ms in both the fast and the slow
mode, so the document is not the variable.

The desktop column is the tell: with no CPU throttling, `animations.js` runs
almost immediately, the reveal is instant, and the animation costs nothing. The
optimisation is real only where the main thread is slow — which is exactly where
customers are.

Reasoning and the rejected alternatives are in
[ADR-0013](../adr/0013-reveal-on-scroll-animations-off.md).

### Card stylesheets loaded conditionally — structural, below the noise floor

`card-product` requested `component-rating`, `component-volume-pricing`,
`quick-order-list` and `quantity-popover` on every render, though the markup
they style is conditional: ratings on `show_rating`, the other three on
`quick_add == 'bulk'`. The home page grid has neither.

| | Before | After |
|---|---|---|
| Theme stylesheets requested | 23 | **19** |
| CSS transferred | 31 KB | **25 KB** |
| Total requests | 312 | 307 |
| Performance score | 73 | 73 |

Four render-blocking requests removed, and the score did not move. The files are
small and arrive on an already-open HTTP/2 connection, so the saving is well
inside the run-to-run spread. Kept anyway, for a reason that does not show up in
this table — see the preload budget below.

### Duplicate font preload removed — structural, no measurable effect

Dawn preloaded `type_body_font` and `type_header_font` separately. Both resolve
to Assistant regular in the default setup, so the head asked for the same woff2
twice. Verified in the served HTML: two preload tags before, one after. No
measurable effect on the score in isolation.

## Why "preload the LCP image" is not on this list

The roadmap asked for it. It does not apply here, for two independent reasons,
and both are worth knowing before reaching for `preload` on the next project.

**There is no LCP image.** The home page banner has no image configured, so the
LCP element is text. Nothing to preload.

**Even if there were, the preload would likely be dropped.** Shopify sends at
most **ten** preload `Link` headers per response. Automatic render-blocking
preloads are placed first; explicit hints fill what remains, in order —
stylesheet preloads, other preloads including fonts, script preloads, and
**image preloads last**. This home page has 27 render-blocking stylesheets. The
budget is gone long before an image preload is considered, so adding one would
have produced markup that looks like an optimisation and does nothing.

That is the real justification for the two "structural, no measurable effect"
changes above: they reduce head weight and free budget slots. On this page that
is not yet enough to matter, and the report says so instead of pretending.

## What was already Dawn's work, not ours

Checked in the code rather than assumed, because claiming these would be
dishonest:

- `preconnect` to `fonts.shopifycdn.com` — `theme.liquid:13`.
- `font_face: font_display: 'swap'` on all five faces — `theme.liquid:75–79`.
- `rel=preload as=font` for body and heading — present already; our change only
  removed the duplicate.
- `fetchpriority` on banner images, driven by `section.index` — `image-banner`,
  `slideshow`, `image-with-text`, `main-article`, passed straight into
  `image_tag`.
- All scripts already `defer`.
- Cart drawer stylesheets already skipped when `cart_type != 'drawer'`.

## What was rejected as a non-optimisation

**Deleting unused Dawn assets.** Of 193 assets, 45 look unreferenced. 43 are
`icon-*.svg` reachable through Dawn's merchant icon picker
(`{% render 'icon-accordion', icon: block.settings.icon %}`) — deleting them
breaks a setting a merchant can legitimately choose, and they are inlined with
`inline_asset_content`, so an unused one costs nothing on the wire. Only
`customer.js` (this theme has no `templates/customers/`) and
`component-progress-bar.css` (those rules live in `base.css`) are genuinely
dead, and Shopify serves assets on demand, so neither is ever requested.
Removing them would save exactly zero bytes on any page. It is repo hygiene, not
performance, and it is not being claimed as one.

## CLS

**0.000 on every run**, mobile and desktop, before and after. No work was needed
and none is claimed.

Two things already prevent it: `image_tag` emits `width` and `height` on every
image, and `bundle-builder` reserves each card's box with
`aspect-ratio: var(--bundle-image-ratio, 1)` plus `object-fit: cover` — the
modern approach Shopify's own CLS guidance endorses over the padding hack.

One measurement trap, recorded so it is not rediscovered: an early reading
showed CLS 0.105 on the product page. It was an artefact of the audit itself —
a scripted scroll-to-bottom collapsed an element 13 seconds after load, long
after the load window Lighthouse measures. Load-phase CLS was 0 all along.

## Accessibility

Full axe-core run (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `best-practice`)
against the live preview theme. Results in [`axe-report.json`](axe-report.json).

Lighthouse accessibility: **97 → 100** on both mobile and desktop.

**A false positive worth knowing about.** The first axe run reported nine
`color-contrast` violations of impact *serious* in the footer — `#fdfdfd` on
`#ffffff`, 1.01:1. The text is not miscoloured. Those elements carried
`scroll-trigger--offscreen`, so Dawn's reveal animation was holding them at
`opacity: 0.01`, and axe measured the blended result. Scrolling the footer into
view before auditing removed all nine.

This cuts both ways, and both matter. As a measurement lesson: **auditing a page
with reveal-on-scroll animations without revealing the content first produces
contrast failures that are not real.** As a product finding: content that is
invisible until a script runs is genuinely fragile, and it is one of the reasons
the animations are now off by default.

**A real bug, on the product page.** The quantity input has no accessible name —
`label`, impact *critical*. Not a false positive, and the cause is subtle: in
`main-product.liquid` every text node inside the `<label>` is
`aria-hidden="true"`, and the name is supplied by `aria-labelledby` on the
`<label>` itself. But when the accessible name of an *input* is computed from its
label, the algorithm walks the label's subtree — where `aria-hidden` nodes are
skipped — and does not consult `aria-labelledby` on the label. The label
contributes nothing, and the input ends up unnamed.

Confirmed by a controlled experiment injected into the live page: the same
markup with `aria-hidden` fails, and without it passes. Fixed on the `feat/a11y`
branch.

## Reports

| File | Configuration |
|---|---|
| [`before-mobile.report.html`](before-mobile.report.html) | mobile, animations on |
| [`after-mobile.report.html`](after-mobile.report.html) | mobile, final |
| [`before-desktop.report.html`](before-desktop.report.html) | desktop, animations on |
| [`after-desktop.report.html`](after-desktop.report.html) | desktop, final |
| [`runs.json`](runs.json) | every run of every configuration, plus medians |
| [`axe-report.json`](axe-report.json) | axe-core violations per page |

## Reproducing this

The Lighthouse job in CI (`.github/workflows/ci.yml`) stays disabled. It is
gated on `vars.PREVIEW_THEME_URL`, and setting that alone would make it measure
the password page and report confident nonsense. Enabling it honestly needs the
`_shopify_essential` cookie as a repository **secret** — not a variable, since
it is a password-derived credential — passed through
`collect.settings.extraHeaders`, plus the preview-bar block used here. A
disabled job is better than a green report about the wrong document.
