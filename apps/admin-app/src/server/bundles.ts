import { Prisma, type PrismaClient } from '@prisma/client';
import {
  ROUTINE_STEPS,
  type Bundle,
  type BundleItem,
  type BundleStatus,
  type RoutineStep,
} from '@nordlys/shared';

import { unwrap, type AdminGraphql } from './admin-graphql';
import { BUNDLE_PRODUCTS, ROUTINE_STEP_PRODUCTS } from './graphql-documents';

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
  products: { nodes: ProductNode[] };
}

/** How many products to inspect when assembling a starter bundle. */
const CATALOG_PAGE_SIZE = 100;

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
): Promise<Bundle> {
  const data = unwrap(
    'RoutineStepProducts',
    await graphql<RoutineStepProductsData>(ROUTINE_STEP_PRODUCTS, {
      first: CATALOG_PAGE_SIZE,
      query: 'status:active',
    }),
  );

  const firstPerStep = new Map<RoutineStep, ProductNode>();
  for (const product of data.products.nodes) {
    const value = product.routineStep?.value;
    if (!value) continue;

    const step = ROUTINE_STEPS.find((candidate) => candidate === value);
    if (step && !firstPerStep.has(step)) {
      firstPerStep.set(step, product);
    }
  }

  const missing = ROUTINE_STEPS.filter((step) => !firstPerStep.has(step));
  if (missing.length > 0) {
    throw new BundleValidationError(
      'The catalog has no active product for every routine step, so a bundle ' +
        'cannot be assembled yet.',
      missing.map(
        (step) =>
          `No active product has custom.routine_step = "${step}". Set the ` +
          `metafield on a product, or run Prepare store if the definition is ` +
          `missing.`,
      ),
    );
  }

  const items = ROUTINE_STEPS.map((step, position) => {
    // Checked by the `missing` guard above; the non-null assertion is the price
    // of Map#get's signature, not an assumption about the data.
    const product = firstPerStep.get(step)!;
    return {
      productGid: product.id,
      routineStep: toPrismaRoutineStep(step),
      position,
    };
  });

  const row = await insertBundleWithUniqueHandle(prisma, shop, items);

  const products = await fetchProducts(
    graphql,
    row.items.map((item) => item.productGid),
  );

  return {
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
  };
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
