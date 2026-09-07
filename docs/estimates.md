# Estimates and actuals

Estimates were set **before work started** and were not adjusted retroactively.
The actuals column and the variance analysis are filled in as work progresses.

Unit: one working day is about 4 hours of focused work.

## Stage 1

| # | Task | Estimate | Actual | Risk flagged upfront |
|---|---|---|---|---|
| 1 | Environment, dev store, catalog, metaobjects | 1.0 | | Platform conventions still being mapped; least reliable estimate of the set |
| 2 | Theme: base plus a metaobject-driven section | 1.0 | | Dawn's structure dictates the layout; discovery time is included |
| 3 | Bundle builder plus Ajax Cart API | 1.0 | | Cart edge cases are routinely underestimated |
| 4 | Performance, accessibility, measurements | 1.0 | | Lighthouse runs are noisy; needs averaged runs |
| 5 | App: OAuth, session storage, Polaris | 1.0 | | OAuth and tunnelling are a classic time sink |
| 6 | Admin GraphQL, webhooks, idempotency | 1.5 | | **Main risk of the stage.** Cost-based throttling and bulk operations are Shopify-specific semantics with a high cost of error |
| 7 | Tests, CI, theme preview publication | 1.0 | | Lighthouse CI is fragile in a pipeline |
| 8 | Documentation, ADRs, code read-through | 1.5 | | Systematically underestimated phase |
| | **Total** | **9.0** | | |

## Risks flagged and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| OAuth or tunnelling eats a day | medium | Use `shopify app dev` rather than wiring OAuth by hand at the start |
| Bulk operations prove more involved than estimated | medium | Fallback: pagination with throttle-aware backoff, plus an ADR explaining why it suffices at this volume |
| Lighthouse CI breaks the pipeline | high | Make the job non-blocking, publish the report as an artifact |
| Scope creep | high | Hard stop at day 8. Anything unfinished moves to roadmap v2 rather than stretching the stage |
| Hosting setup eats time | medium | Removed by ADR-0008: deployment deferred, the app runs locally |
| The walkthrough video runs long | medium | It is the only way to show the app outside the admin. Budget for editing; do not record in one take |
| Webhooks and rate limits done superficially | medium | Day 6 is not to be shortened: it is the core of the project and everything else sits around it |

## Variance analysis (to be completed)

> Format for every task with variance above 30%:
>
> **Task N.** Estimate X, actual Y.
> Cause: …
> What was not accounted for: …
> How I would estimate it now: …

The variance analysis matters more than the numbers themselves: it shows which
factors were missed at estimation time and how the estimate would change now.

## Stage 2 (high level)

| Block | Estimate |
|---|---|
| A — Migrating the app to Express | 2.0 |
| B — Integration: mock ERP, worker, DLQ, conflicts | 3.5 |
| C — Extensions: app block, Function, Checkout UI | 2.5 |
| D — Infrastructure: workspace, codegen, e2e, observability | 2.0 |
| E — AI workflow: skills, custom MCP, review loop | 1.5 |
| | **11.5** (on top of stage 1) |
