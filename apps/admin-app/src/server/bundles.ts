import { Prisma, type PrismaClient } from '@prisma/client';
import {
  ROUTINE_STEPS,
  type Bundle,
  type BundleItem,
  type BundleStatus,
  type RoutineStep,
} from '@nordlys/shared';

import {
  unwrap,
  type AdminGraphql,
  type AdminGraphqlResponse,
} from './admin-graphql';
import { BUNDLE_PRODUCTS, ROUTINE_STEP_PRODUCTS } from './graphql-documents';
import { createThrottleGate, type ThrottleGateOptions } from './throttle';

/**
 * Bundles: the one domain object this app owns.
 *
 * Products, inventory and orders stay in Shopify (ADR-0007); a routine set is
 * the thing Shopify has nowhere to put, so it lives in our database. That split
 * is why every read here is a join across two systems: the rows come from
 * PostgreSQL, and the product titles come from the Admin API on each request
 * instead of being cached next to the row, so a product renamed in the admin
 * shows its new name here immediately.
 */

/** Raised when the store's catalog cannot satisfy the request. */
export class BundleValidationError extends Error {
  readonly detail: readonly string[];

  constructor(message: string, detail: readonly string[] = []) {
    super(message);
    this.name = 'BundleValidationError';
    this.detail = detail;
  }
}

type PrismaRoutineStep = 'CLEANSE' | 'TREAT' | 'MOISTURIZE';
type PrismaBundleStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';

export function toPrismaRoutineStep(step: RoutineStep): PrismaRoutineStep {
  return step.toUpperCase() as PrismaRoutineStep;
}

export function fromPrismaRoutineStep(step: PrismaRoutineStep): RoutineStep {
  return step.toLowerCase() as RoutineStep;
}

export function fromPrismaBundleStatus(
  status: PrismaBundleStatus,
): BundleStatus {
  return status.toLowerCase() as BundleStatus;
}

interface ProductNode {
  id: string;
  title: string;
  status: 'ACTIVE' | 'ARCHIVED' | 'DRAFT';
  routineStep: { value: string | null } | null;
}

interface BundleProductsData {
  /** `null` for any id the current token can no longer resolve. */
  nodes: (ProductNode | null)[];
}

interface RoutineStepProductsData {
  products: {
    nodes: ProductNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

/** Products per page when searching the catalog. 250 is the Admin API maximum. */
const CATALOG_PAGE_SIZE = 250;

/**
 * How many pages the starter-bundle search will read before giving up.
 *
 * There is a bound rather than "until `hasNextPage` is false" because this runs
 * inside a button press. 2,500 products is far more than the search needs — it
 * stops as soon as all three steps are filled, which on a normal catalog is the
 * first page — and a store larger than that has a different problem: a full
 * catalog scan there belongs in a bulk operation (rule 4, ADR-0004), not in a
 * synchronous request.
 */
const MAX_CATALOG_PAGES = 10;

/**
 * Look up the products a set of bundles refers to, in one request.
 *
 * One `nodes(ids:)` call rather than one call per product: a bundle list of ten
 * sets is thirty products, and thirty round trips would be thirty times the
 * cost against the same rate-limit bucket for the same data.
 */
async function fetchProducts(
  graphql: AdminGraphql,
  gids: readonly string[],
): Promise<Map<string, ProductNode>> {
  if (gids.length === 0) return new Map();

  const data = unwrap(
    'BundleProducts',
    await graphql<BundleProductsData>(BUNDLE_PRODUCTS, { ids: [...gids] }),
  );

  const byGid = new Map<string, ProductNode>();
  for (const node of data.nodes) {
    if (node) byGid.set(node.id, node);
  }
  return byGid;
}

export async function listBundles(
  prisma: PrismaClient,
  graphql: AdminGraphql,
  shop: string,
): Promise<Bundle[]> {
  const rows = await prisma.bundle.findMany({
    // Scoped to the shop, always. One deployment serves many stores, and a
    // query without this filter is a cross-tenant leak rather than a bug in
    // one screen.
    where: { shop },
    orderBy: { updatedAt: 'desc' },
    include: { items: { orderBy: { position: 'asc' } } },
  });

  const gids = [
    ...new Set(rows.flatMap((row) => row.items.map((item) => item.productGid))),
  ];
  const products = await fetchProducts(graphql, gids);

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    handle: row.handle,
    status: fromPrismaBundleStatus(row.status),
    updatedAt: row.updatedAt.toISOString(),
    items: row.items.map((item): BundleItem => {
      const product = products.get(item.productGid);
      return {
        productGid: item.productGid,
        routineStep: fromPrismaRoutineStep(item.routineStep),
        position: item.position,
        title: product?.title ?? null,
        productStatus: product?.status ?? null,
      };
    }),
  }));
}

/**
 * Assemble one bundle from the catalog: the first active product of each step.
 *
 * This is what the empty state offers. A first bundle built from real catalog
 * data is more useful than an empty form, and it is the shortest path that
 * exercises the whole stack end to end - Admin API read, database write, and
 * the screen re-rendering with live product titles.
 */
export async function createStarterBundle(
  prisma: PrismaClient,
  graphql: AdminGraphql,
  shop: string,
  throttleOptions: ThrottleGateOptions = {},
): Promise<Bundle> {
  const { chosen, scanned, exhausted } = await findFirstProductPerStep(
    graphql,
    throttleOptions,
  );

  const missing = ROUTINE_STEPS.filter((step) => !chosen.has(step));
  if (missing.length > 0) {
    // The scope of the claim matters. Saying "the catalog has none" after
    // looking at one page is a lie the merchant cannot check, and it sends them
    // looking for a metafield problem that may not exist.
    const scope = exhausted
      ? `none of the ${scanned} active products in the catalog`
      : `none of the first ${scanned} active products (the search stopped ` +
        `there; the catalog has more)`;

    throw new BundleValidationError(
      `A routine set needs one product per step, and ${scope} covers every ` +
        `step yet.`,
      missing.map(
        (step) =>
          `No active product found with custom.routine_step = "${step}". Set ` +
          `the metafield on a product, or run Prepare store if the definition ` +
          `is missing.`,
      ),
    );
  }

  const items = ROUTINE_STEPS.map((step, position) => {
    // Guaranteed by the `missing` check above; the assertion is the price of
    // Map#get's signature, not an assumption about the data.
    const product = chosen.get(step)!;
    return {
      productGid: product.id,
      routineStep: toPrismaRoutineStep(step),
      position,
    };
  });

  const row = await insertBundleWithUniqueHandle(prisma, shop, items);

  // Built from the products the search already returned, with no second Admin
  // API call. An earlier version re-fetched them here, after the insert had
  // committed: a Shopify hiccup in that window answered the merchant with an
  // error for a bundle that had in fact been created, and pressing the button
  // again made a second one. There is no request left between the write and the
  // response to fail.
  const byGid = new Map(
    [...chosen.values()].map((product) => [product.id, product]),
  );

  return {
    id: row.id,
    title: row.title,
    handle: row.handle,
    status: fromPrismaBundleStatus(row.status),
    updatedAt: row.updatedAt.toISOString(),
    items: row.items.map((item): BundleItem => {
      const product = byGid.get(item.productGid);
      return {
        productGid: item.productGid,
        routineStep: fromPrismaRoutineStep(item.routineStep),
        position: item.position,
        title: product?.title ?? null,
        productStatus: product?.status ?? null,
      };
    }),
  };
}

interface CatalogSearchResult {
  /** The first active product found for each step. */
  chosen: Map<RoutineStep, ProductNode>;
  /** How many active products were actually looked at. */
  scanned: number;
  /** Whether the search reached the end of the catalog rather than its page cap. */
  exhausted: boolean;
}

/**
 * Walk the active catalog until every routine step has a product, or the pages
 * run out.
 *
 * The step is read as a field rather than used as a `query:` filter because
 * filtering products by a metafield needs the definition to be
 * admin-filterable, which this store's is not — and asking for a filter the
 * definition cannot serve returns everything, silently. So the grouping happens
 * here.
 *
 * Rule 4: this is a loop of Admin API calls, so each response feeds the
 * throttle gate and the next page waits when the bucket cannot afford it.
 */
async function findFirstProductPerStep(
  graphql: AdminGraphql,
  throttleOptions: ThrottleGateOptions,
): Promise<CatalogSearchResult> {
  const gate = createThrottleGate(throttleOptions);
  const chosen = new Map<RoutineStep, ProductNode>();

  let after: string | null = null;
  let scanned = 0;
  let exhausted = false;

  for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
    await gate.beforeCall();

    // Annotated rather than inferred: `after` is assigned from this response's
    // own `pageInfo`, and without the annotation that is a circular inference
    // TypeScript resolves to `any`.
    const response: AdminGraphqlResponse<RoutineStepProductsData> =
      await graphql<RoutineStepProductsData>(ROUTINE_STEP_PRODUCTS, {
        first: CATALOG_PAGE_SIZE,
        query: 'status:active',
        ...(after === null ? {} : { after }),
      });
    gate.record(response.extensions?.cost);

    const { products } = unwrap('RoutineStepProducts', response);

    for (const product of products.nodes) {
      scanned += 1;

      const value = product.routineStep?.value;
      if (!value) continue;

      const step = ROUTINE_STEPS.find((candidate) => candidate === value);
      if (step && !chosen.has(step)) {
        chosen.set(step, product);
      }
    }

    // Every step filled: nothing later in the catalog can change the answer,
    // and `exhausted` only shapes the "not found" message, which is not needed.
    if (chosen.size === ROUTINE_STEPS.length) {
      return { chosen, scanned, exhausted: !products.pageInfo.hasNextPage };
    }

    if (!products.pageInfo.hasNextPage) {
      exhausted = true;
      break;
    }

    after = products.pageInfo.endCursor;
    if (after === null) {
      // hasNextPage with no cursor should not happen; treating it as the end is
      // better than looping on the same page.
      exhausted = true;
      break;
    }
  }

  return { chosen, scanned, exhausted };
}

interface NewBundleItem {
  productGid: string;
  routineStep: PrismaRoutineStep;
  position: number;
}

/**
 * Insert the bundle, letting the database decide whether the handle is free.
 *
 * The alternative - count the rows, build a handle, check it is unused, insert -
 * is a race between the check and the insert (rule 10). Here the unique index
 * on `(shop, handle)` is the check: on a collision Prisma raises P2002 and the
 * next candidate is tried. Bounded, because an unbounded retry on a persistent
 * constraint failure is an infinite loop rather than resilience.
 */
async function insertBundleWithUniqueHandle(
  prisma: PrismaClient,
  shop: string,
  items: readonly NewBundleItem[],
  maxAttempts = 10,
) {
  const existing = await prisma.bundle.count({ where: { shop } });

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const ordinal = existing + attempt + 1;

    try {
      return await prisma.bundle.create({
        data: {
          shop,
          title: `Routine set ${ordinal}`,
          handle: `routine-set-${ordinal}`,
          items: { create: [...items] },
        },
        include: { items: { orderBy: { position: 'asc' } } },
      });
    } catch (error) {
      const isHandleCollision =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002';

      if (!isHandleCollision) throw error;
    }
  }

  throw new BundleValidationError(
    `Could not find a free bundle handle after ${maxAttempts} attempts.`,
  );
}
