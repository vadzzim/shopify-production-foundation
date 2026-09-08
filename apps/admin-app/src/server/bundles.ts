import { Prisma, type PrismaClient } from '@prisma/client';
import {
  ROUTINE_STEPS,
  type Bundle,
  type BundleItem,
  type BundleItemInput,
  type BundleStatus,
  type BundleUpdate,
  type CatalogCandidate,
  type CatalogCandidates,
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

/** Raised when this shop has no bundle with the requested id. */
export class BundleNotFoundError extends Error {
  constructor(id: string) {
    super(`No routine set with id "${id}" belongs to this shop.`);
    this.name = 'BundleNotFoundError';
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

export function toPrismaBundleStatus(
  status: BundleStatus,
): PrismaBundleStatus {
  return status.toUpperCase() as PrismaBundleStatus;
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

/** The columns every bundle response is built from. */
interface BundleRow {
  id: string;
  title: string;
  handle: string;
  status: PrismaBundleStatus;
  updatedAt: Date;
  items: {
    productGid: string;
    routineStep: PrismaRoutineStep;
    position: number;
  }[];
}

/**
 * Join one stored bundle with what Shopify says about its products.
 *
 * A product missing from the map is not an error: `nodes(ids:)` answers `null`
 * for anything this token can no longer see, which is what a product deleted
 * since it was added looks like. That becomes `title: null`, and the screen
 * renders it as "no longer in the catalog" rather than showing a name that is
 * no longer true.
 */
function toBundle(row: BundleRow, products: Map<string, ProductNode>): Bundle {
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

  return rows.map((row) => toBundle(row, products));
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

  return toBundle(row, byGid);
}

/**
 * Change a bundle the merchant already has.
 *
 * The interesting decision here is **where the catalog is checked.** A draft is
 * the merchant's workspace: half-finished sets, products that are not published
 * yet, a slot pointed at something they mean to fix. Refusing those edits would
 * make the app harder to use than the admin it lives in. ACTIVE is different —
 * it is the state the storefront renders — so the catalog checks are attached
 * to activation rather than to editing.
 *
 * The three conditions are exactly the ones `product.reconcile` demotes a
 * bundle for when a merchant changes a product afterwards (see
 * `job-handlers.ts`): the product must exist, be active, and carry the step it
 * is being used as. One invariant, enforced at both ends — anything else would
 * let the app accept a set and then demote it moments later without the
 * merchant having done anything.
 */
export async function updateBundle(
  prisma: PrismaClient,
  graphql: AdminGraphql,
  shop: string,
  id: string,
  update: BundleUpdate,
): Promise<Bundle> {
  const existing = await prisma.bundle.findFirst({
    // Scoped to the shop: an id on its own is another tenant's row.
    where: { id, shop },
    include: { items: { orderBy: { position: 'asc' } } },
  });

  if (!existing) throw new BundleNotFoundError(id);

  const items: BundleItemInput[] =
    update.items ??
    existing.items.map((item) => ({
      productGid: item.productGid,
      routineStep: fromPrismaRoutineStep(item.routineStep),
    }));

  const status = update.status ?? fromPrismaBundleStatus(existing.status);

  // One call for the whole set, and the same call serves both the validation
  // below and the response — the titles have to be read live either way.
  const products = await fetchProducts(
    graphql,
    items.map((item) => item.productGid),
  );

  if (status === 'active') {
    assertActivatable(items, products);
  }

  const row = await prisma.$transaction(async (tx) => {
    if (update.items) {
      // Replaced rather than reconciled slot by slot. The unique index on
      // `[bundleId, routineStep]` makes a partial update order-dependent —
      // moving a product from treat to cleanse collides with whatever is in
      // cleanse until that row is gone — and inside one transaction the
      // delete-then-create is atomic, so no reader ever sees the empty set.
      await tx.bundleItem.deleteMany({ where: { bundleId: existing.id } });
    }

    return tx.bundle.update({
      // Both, again: Prisma allows non-unique fields alongside the id here, and
      // a write scoped only by id would be reachable from another shop.
      where: { id: existing.id, shop },
      data: {
        ...(update.title === undefined ? {} : { title: update.title }),
        ...(update.status === undefined
          ? {}
          : { status: toPrismaBundleStatus(update.status) }),
        ...(update.items === undefined
          ? {}
          : {
              items: {
                create: update.items.map((item) => ({
                  productGid: item.productGid,
                  routineStep: toPrismaRoutineStep(item.routineStep),
                  // Not the client's to choose: a routine is a sequence, and
                  // the order is the one ROUTINE_STEPS declares.
                  position: ROUTINE_STEPS.indexOf(item.routineStep),
                })),
              },
            }),
      },
      include: { items: { orderBy: { position: 'asc' } } },
    });
  });

  return toBundle(row, products);
}

/**
 * Refuse to activate a set the storefront could not render.
 *
 * Every problem is collected rather than thrown on the first one: a merchant
 * fixing three slots one round trip at a time is a worse experience than being
 * told all three at once, and the error envelope already carries a `detail`
 * array for exactly this.
 */
function assertActivatable(
  items: readonly BundleItemInput[],
  products: Map<string, ProductNode>,
): void {
  const problems: string[] = [];

  for (const item of items) {
    const product = products.get(item.productGid);

    if (!product) {
      problems.push(
        `${item.routineStep}: the product is not in the catalog any more.`,
      );
      continue;
    }

    if (product.status !== 'ACTIVE') {
      problems.push(
        `${item.routineStep}: "${product.title}" is ${product.status.toLowerCase()} ` +
          `in Shopify, so the storefront cannot show it.`,
      );
      continue;
    }

    const step = product.routineStep?.value ?? null;
    if (step !== item.routineStep) {
      problems.push(
        `${item.routineStep}: "${product.title}" has custom.routine_step = ` +
          `${step === null ? '(not set)' : `"${step}"`}. The theme filters on ` +
          `that metafield, so it would not appear in this slot.`,
      );
    }
  }

  if (problems.length > 0) {
    throw new BundleValidationError(
      'This routine set cannot be activated yet.',
      problems,
    );
  }
}

/**
 * Delete a bundle.
 *
 * `deleteMany` with the shop in the filter rather than a read followed by a
 * delete by id: the row count answers "was it yours?" in the same statement
 * that removes it, and there is no window between the two for a concurrent
 * delete to make the answer wrong. `BundleItem` goes with it — the relation
 * cascades in the schema, so the items cannot outlive their bundle.
 */
export async function deleteBundle(
  prisma: PrismaClient,
  shop: string,
  id: string,
): Promise<void> {
  const deleted = await prisma.bundle.deleteMany({ where: { id, shop } });

  if (deleted.count === 0) throw new BundleNotFoundError(id);
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
 * here, in the visitor {@link scanActiveCatalog} calls.
 */
async function findFirstProductPerStep(
  graphql: AdminGraphql,
  throttleOptions: ThrottleGateOptions,
): Promise<CatalogSearchResult> {
  const chosen = new Map<RoutineStep, ProductNode>();

  const { scanned, exhausted } = await scanActiveCatalog(
    graphql,
    throttleOptions,
    (product) => {
      const step = routineStepOf(product);
      if (step && !chosen.has(step)) chosen.set(step, product);

      // Every step filled: nothing later in the catalog can change the answer.
      return chosen.size === ROUTINE_STEPS.length ? 'stop' : 'continue';
    },
  );

  return { chosen, scanned, exhausted };
}

/** How many products per step the editor's picker offers. */
const MAX_CANDIDATES_PER_STEP = 100;

/**
 * The products the bundle editor offers for each step.
 *
 * Same walk as the starter search, different stopping rule: it collects until
 * every step has enough options to choose from rather than until every step has
 * one. The cap is per step because the interesting case is a catalog where one
 * step is common and another is rare — stopping at a total would fill the list
 * with cleansers and never reach a single moisturizer.
 *
 * What this cannot do is offer the whole catalog, and the result says so.
 * `custom.routine_step` is not admin-filterable, so "all products whose step is
 * treat" is not a question the Admin API can be asked in a request; the
 * complete answer is a bulk operation (ADR-0004), which is what the catalog
 * export is for.
 */
export async function listCandidateProducts(
  graphql: AdminGraphql,
  throttleOptions: ThrottleGateOptions = {},
): Promise<CatalogCandidates> {
  const candidates: CatalogCandidate[] = [];
  const perStep = new Map<RoutineStep, number>();

  const { scanned, exhausted } = await scanActiveCatalog(
    graphql,
    throttleOptions,
    (product) => {
      const step = routineStepOf(product);
      if (!step) return 'continue';

      const taken = perStep.get(step) ?? 0;
      if (taken < MAX_CANDIDATES_PER_STEP) {
        perStep.set(step, taken + 1);
        candidates.push({
          productGid: product.id,
          title: product.title,
          routineStep: step,
          productStatus: product.status,
        });
      }

      const full = ROUTINE_STEPS.every(
        (candidate) => (perStep.get(candidate) ?? 0) >= MAX_CANDIDATES_PER_STEP,
      );
      return full ? 'stop' : 'continue';
    },
  );

  return { candidates, scanned, exhausted };
}

/** The step a product declares, or `null` if it declares none this app knows. */
function routineStepOf(product: ProductNode): RoutineStep | null {
  const value = product.routineStep?.value;
  if (!value) return null;

  return ROUTINE_STEPS.find((step) => step === value) ?? null;
}

/** Told for each product whether the caller has seen enough. */
type ScanVisitor = (product: ProductNode) => 'continue' | 'stop';

/**
 * Walk the active catalog, page by page, until the visitor says stop or the
 * pages run out.
 *
 * Rule 4: this is a loop of Admin API calls, so each response feeds the
 * throttle gate and the next page waits when the bucket cannot afford it.
 */
async function scanActiveCatalog(
  graphql: AdminGraphql,
  throttleOptions: ThrottleGateOptions,
  visit: ScanVisitor,
): Promise<{ scanned: number; exhausted: boolean }> {
  const gate = createThrottleGate(throttleOptions);

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

    let stop = false;

    for (const product of products.nodes) {
      scanned += 1;
      if (visit(product) === 'stop') {
        stop = true;
        break;
      }
    }

    if (stop) {
      // Whether the rest of the catalog was read is still worth reporting: it
      // is the difference between "these are all of them" and "these are the
      // first of them".
      return { scanned, exhausted: !products.pageInfo.hasNextPage };
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

  return { scanned, exhausted };
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
