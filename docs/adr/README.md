# Architecture Decision Records

Every decision that is expensive to reverse is recorded here, using
`0000-template.md`.

An ADR is written **when the decision is made**, not retroactively: the value is
in showing which alternatives were on the table and what was known at the time.

## Index

| # | Decision | Status |
|---|---|---|
| [0001](0001-stack-and-architecture.md) | Stack and overall architecture | accepted |
| [0002](0002-express-over-the-app-template.md) | Express with `@shopify/shopify-app-express`, not Shopify's app template | accepted |
| [0003](0003-metaobjects-for-ingredients.md) | Metaobjects instead of metafields for ingredients | accepted |
| 0004 | Bulk operations vs pagination for catalog export | *planned* |
| 0005 | Rejecting Hydrogen / headless | *planned* |
| 0006 | Conflict resolution strategy for two-way sync | *roadmap v2* |
| [0007](0007-database-and-orm.md) | PostgreSQL + Prisma, queue on a table | accepted |
| [0008](0008-hosting-topology.md) | Hosting: local runtime plus theme preview | accepted |
| [0009](0009-admin-api-version.md) | Admin API version pinned to 2026-07 | accepted |
| [0010](0010-section-composition-field-blocks.md) | Section blocks are the card's fields, not the ingredients | accepted |
| [0011](0011-dawn-over-skeleton-theme.md) | Dawn over the Skeleton theme as the base for stage 1 | accepted |
| [0012](0012-bundle-add-to-cart-transaction.md) | One Ajax add for a bundle, all-or-nothing enforced by the theme | accepted |
| [0013](0013-reveal-on-scroll-animations-off.md) | Reveal-on-scroll animations off by default | accepted |
| [0014](0014-cart-notification-over-drawer.md) | Keep the cart notification; do not enable the cart drawer | accepted |
| [0015](0015-polaris-web-components-over-polaris-react.md) | Polaris web components, not Polaris React | accepted |
