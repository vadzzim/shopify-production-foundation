import { Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import type { AdminGraphql } from './admin-graphql';
import {
  BundleNotFoundError,
  BundleValidationError,
  createStarterBundle,
  deleteBundle,
  listBundles,
  listCandidateProducts,
  updateBundle,
} from './bundles';

const SHOP = 'ecorn-oj1cb5ll.myshopify.com';

interface FakeProduct {
  id: string;
  title: string;
  status: 'ACTIVE' | 'ARCHIVED' | 'DRAFT';
  routineStep: { value: string | null } | null;
}

function product(id: string, step: string | null): FakeProduct {
  return {
    id: `gid://shopify/Product/${id}`,
    title: `Product ${id}`,
    status: 'ACTIVE',
    routineStep: step === null ? null : { value: step },
  };
}

interface AdminCall {
  document: string;
  after: string | null;
}

/**
 * A paginated fake catalog.
 *
 * Each entry in `pages` is one page of products, answered in order, with a
 * cursor between them. `calls` records what was asked for, which is how the
 * tests below assert on the *number* of Admin API calls — the property that
 * matters for both bugs in this file's history.
 */
function fakeCatalog(pages: FakeProduct[][]): {
  graphql: AdminGraphql;
  calls: AdminCall[];
} {
  const calls: AdminCall[] = [];
  let index = 0;

  const graphql: AdminGraphql = async (document, variables) => {
    const after = (variables?.after as string | undefined) ?? null;
    calls.push({ document, after });

    if (!document.includes('RoutineStepProducts')) {
      throw new Error(`Unexpected document: ${document.slice(0, 40)}`);
    }

    const page = pages[index] ?? [];
    index += 1;
    const hasNextPage = index < pages.length;

    return {
      data: {
        products: {
          nodes: page,
          pageInfo: {
            hasNextPage,
            endCursor: hasNextPage ? `cursor-${index}` : null,
          },
        },
      } as never,
      extensions: {
        cost: {
          requestedQueryCost: 10,
          actualQueryCost: 10,
          throttleStatus: {
            maximumAvailable: 2000,
            currentlyAvailable: 1990,
            restoreRate: 100,
          },
        },
      },
    };
  };

  return { graphql, calls };
}

interface CreateArgs {
  data: {
    shop: string;
    title: string;
    handle: string;
    items: { create: { productGid: string; routineStep: string; position: number }[] };
  };
}

/**
 * A database holding routine sets with the given handles.
 *
 * The handles are what the insert has to work around, so they are the only
 * thing the fake stores about the existing rows: `create` refuses one that is
 * already there the way the unique index on `(shop, handle)` does.
 */
function fakePrisma(
  handles: readonly string[] = [],
  /**
   * Handles the read does not see but the insert still refuses.
   *
   * The concurrent case: another request claimed the handle after this one read
   * the shop's rows, so the unique index is the only thing that knows.
   */
  claimedElsewhere: readonly string[] = [],
): PrismaClient {
  const taken = new Set([...handles, ...claimedElsewhere]);

  return {
    bundle: {
      findMany: async () => handles.map((handle) => ({ handle })),
      create: async ({ data }: CreateArgs) => {
        if (taken.has(data.handle)) {
          throw new Prisma.PrismaClientKnownRequestError('handle taken', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }

        return {
          id: 'bundle_1',
          shop: data.shop,
          title: data.title,
          handle: data.handle,
          status: 'DRAFT',
          createdAt: new Date('2026-09-08T00:00:00.000Z'),
          updatedAt: new Date('2026-09-08T00:00:00.000Z'),
          items: data.items.create.map((item, index) => ({
            id: `item_${index}`,
            bundleId: 'bundle_1',
            ...item,
          })),
        };
      },
    },
  } as unknown as PrismaClient;
}

const noWait = { sleep: async () => {}, random: () => 0 };

const fullFirstPage = [
  product('1', 'cleanse'),
  product('2', 'treat'),
  product('3', 'moisturize'),
];

describe('createStarterBundle', () => {
  it('builds a set from the first product of each step', async () => {
    const { graphql } = fakeCatalog([fullFirstPage]);

    const bundle = await createStarterBundle(
      fakePrisma(),
      graphql,
      SHOP,
      noWait,
    );

    expect(bundle.items).toEqual([
      expect.objectContaining({
        routineStep: 'cleanse',
        title: 'Product 1',
        productStatus: 'ACTIVE',
      }),
      expect.objectContaining({ routineStep: 'treat', title: 'Product 2' }),
      expect.objectContaining({ routineStep: 'moisturize', title: 'Product 3' }),
    ]);
  });

  it('makes no Admin API call after the database write', async () => {
    // The bug this pins: the response used to be assembled from a second
    // `nodes(ids:)` call issued *after* the insert had committed. A Shopify
    // hiccup in that window answered the merchant with an error for a bundle
    // that existed, and pressing the button again created a second one. The
    // product data was already in hand from the search, so the fix is that
    // there is no request left to fail.
    const { graphql, calls } = fakeCatalog([fullFirstPage]);

    await createStarterBundle(fakePrisma(), graphql, SHOP, noWait);

    expect(calls).toHaveLength(1);
    expect(
      calls.some((call) => call.document.includes('BundleProducts')),
    ).toBe(false);
  });

  it('numbers the handle past the highest one in use, not past the row count', async () => {
    // The bug this pins: the number came from the row count, so a shop that
    // created sets 1 to 21 and deleted the first ten had eleven rows and
    // handles 12 to 21. Every candidate the count suggested was taken, and the
    // create failed however many times the merchant pressed the button.
    const handles = Array.from({ length: 10 }, (_, index) =>
      `routine-set-${String(index + 12)}`,
    );
    const { graphql } = fakeCatalog([fullFirstPage]);

    const bundle = await createStarterBundle(
      fakePrisma(handles),
      graphql,
      SHOP,
      noWait,
    );

    expect(bundle.handle).toBe('routine-set-22');
    // A number is never reused, which is also what a merchant expects of a URL
    // that used to be a different routine set.
    expect(bundle.title).toBe('Routine set 22');
  });

  it('ignores handles that are not part of the numbering', async () => {
    // A handle renamed by hand, or written by a future scheme. Skipped rather
    // than parsed into whatever `Number` makes of it.
    const { graphql } = fakeCatalog([fullFirstPage]);

    const bundle = await createStarterBundle(
      fakePrisma(['morning-routine', 'routine-set-3-copy', 'routine-set-4']),
      graphql,
      SHOP,
      noWait,
    );

    expect(bundle.handle).toBe('routine-set-5');
  });

  it('takes the next free handle when one is claimed under it', async () => {
    // Two merchants pressing the button at once: the first insert wins the
    // handle and the second gets P2002 from the unique index, which is the
    // check (rule 10). The retry walks on rather than reporting a failure.
    const { graphql } = fakeCatalog([fullFirstPage]);

    const bundle = await createStarterBundle(
      // Nothing to read — the racing insert had not committed when this request
      // looked — and `routine-set-1` refused on write.
      fakePrisma([], ['routine-set-1']),
      graphql,
      SHOP,
      noWait,
    );

    expect(bundle.handle).toBe('routine-set-2');
  });

  it('stops paging as soon as every step is filled', async () => {
    const { graphql, calls } = fakeCatalog([
      fullFirstPage,
      [product('4', 'cleanse')],
    ]);

    await createStarterBundle(fakePrisma(), graphql, SHOP, noWait);

    expect(calls).toHaveLength(1);
  });

  it('finds a step that only appears on a later page', async () => {
    // The bug this pins: the search read one page of 100 and then told the
    // merchant the catalog had no product for the step. On a catalog where the
    // moisturizers sort after the first page, that claim was simply false.
    const { graphql, calls } = fakeCatalog([
      [product('1', 'cleanse'), product('2', 'treat')],
      [product('3', null), product('4', 'moisturize')],
    ]);

    const bundle = await createStarterBundle(
      fakePrisma(),
      graphql,
      SHOP,
      noWait,
    );

    expect(calls.map((call) => call.after)).toEqual([null, 'cursor-1']);
    expect(
      bundle.items.find((item) => item.routineStep === 'moisturize')?.title,
    ).toBe('Product 4');
  });

  it('refuses, naming the steps it could not fill and how much it read', async () => {
    const { graphql } = fakeCatalog([[product('1', 'cleanse')]]);

    try {
      await createStarterBundle(fakePrisma(), graphql, SHOP, noWait);
      expect.unreachable('createStarterBundle should have thrown');
    } catch (error) {
      const validation = error as BundleValidationError;
      expect(validation).toBeInstanceOf(BundleValidationError);
      expect(validation.message).toContain('1 active products in the catalog');
      expect(validation.detail.join(' ')).toContain('"treat"');
      expect(validation.detail.join(' ')).toContain('"moisturize"');
    }
  });

  it('does not claim the whole catalog when it stopped at the page cap', async () => {
    // Ten pages is the cap. An eleventh page means the search gave up rather
    // than finished, and the message has to say which — telling a merchant
    // their catalog is missing a product when the search never looked sends
    // them hunting for a metafield problem that does not exist.
    const pages = Array.from({ length: 11 }, () => [product('x', 'cleanse')]);
    const { graphql, calls } = fakeCatalog(pages);

    try {
      await createStarterBundle(fakePrisma(), graphql, SHOP, noWait);
      expect.unreachable('createStarterBundle should have thrown');
    } catch (error) {
      expect(calls).toHaveLength(10);
      expect((error as BundleValidationError).message).toContain(
        'the catalog has more',
      );
    }
  });

  it('ignores products whose routine step is unset or unrecognised', async () => {
    const { graphql } = fakeCatalog([
      [
        product('1', null),
        product('2', 'exfoliate'),
        product('3', 'cleanse'),
        product('4', 'treat'),
        product('5', 'moisturize'),
      ],
    ]);

    const bundle = await createStarterBundle(
      fakePrisma(),
      graphql,
      SHOP,
      noWait,
    );

    expect(
      bundle.items.find((item) => item.routineStep === 'cleanse')?.title,
    ).toBe('Product 3');
  });
});

describe('listBundles', () => {
  /**
   * A shop with `count` routine sets, each on three products of its own.
   *
   * Distinct products per set is what matters: the lookup is by unique product
   * gid, so a shop that reuses the same cleanser everywhere never approaches the
   * limit however many sets it has.
   */
  function shopWith(count: number): {
    prisma: PrismaClient;
    batches: number[];
  } {
    const rows = Array.from({ length: count }, (_, index) => ({
      id: `bundle_${String(index)}`,
      title: `Routine set ${String(index + 1)}`,
      handle: `routine-set-${String(index + 1)}`,
      status: 'DRAFT' as const,
      updatedAt: new Date('2026-09-08T00:00:00.000Z'),
      items: (['CLEANSE', 'TREAT', 'MOISTURIZE'] as const).map(
        (routineStep, position) => ({
          productGid: `gid://shopify/Product/${String(index * 3 + position)}`,
          routineStep,
          position,
        }),
      ),
    }));

    const batches: number[] = [];

    const graphql: AdminGraphql = async (document, variables) => {
      if (!document.includes('BundleProducts')) {
        throw new Error(`Unexpected document: ${document.slice(0, 40)}`);
      }

      const ids = variables?.ids as string[];
      batches.push(ids.length);

      return {
        data: {
          nodes: ids.map((id) => ({
            id,
            title: `Product ${id}`,
            status: 'ACTIVE',
            routineStep: { value: 'cleanse' },
          })),
        } as never,
        extensions: {
          cost: {
            requestedQueryCost: 500,
            actualQueryCost: 500,
            throttleStatus: {
              maximumAvailable: 2000,
              currentlyAvailable: 1500,
              restoreRate: 100,
            },
          },
        },
      };
    };

    return {
      prisma: {
        bundle: { findMany: async () => rows },
        // Threaded through so the test can name the graphql it built.
        graphql,
      } as unknown as PrismaClient & { graphql: AdminGraphql },
      batches,
    };
  }

  function graphqlOf(prisma: PrismaClient): AdminGraphql {
    return (prisma as unknown as { graphql: AdminGraphql }).graphql;
  }

  it('splits the product lookup into batches of 250', async () => {
    // The bug this pins: every distinct product across every routine set went
    // into one `nodes(ids:)` call. Shopify caps an input array at 250 and
    // rejects the query past it, so the whole list — and the editor, which
    // loads through the same path — became unavailable to a shop with more
    // products in its sets than that.
    const { prisma, batches } = shopWith(100);

    const bundles = await listBundles(prisma, graphqlOf(prisma), SHOP, noWait);

    expect(batches).toEqual([250, 50]);
    expect(bundles).toHaveLength(100);
    // Every set still gets its titles: the batches are joined, not the last one
    // kept.
    expect(bundles.every((bundle) =>
      bundle.items.every((item) => item.title !== null),
    )).toBe(true);
  });

  it('makes one call when the products fit in a single batch', async () => {
    const { prisma, batches } = shopWith(10);

    await listBundles(prisma, graphqlOf(prisma), SHOP, noWait);

    expect(batches).toEqual([30]);
  });

  it('makes no call at all for a shop with no bundles', async () => {
    const { prisma, batches } = shopWith(0);

    expect(await listBundles(prisma, graphqlOf(prisma), SHOP, noWait)).toEqual(
      [],
    );
    expect(batches).toEqual([]);
  });
});

type PrismaStep = 'CLEANSE' | 'TREAT' | 'MOISTURIZE';

interface StoredItem {
  id: string;
  bundleId: string;
  productGid: string;
  routineStep: PrismaStep;
  position: number;
}

interface StoredBundle {
  id: string;
  shop: string;
  title: string;
  handle: string;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  createdAt: Date;
  updatedAt: Date;
  items: StoredItem[];
}

function storedItem(gid: string, step: PrismaStep, position: number): StoredItem {
  return {
    id: `item_${step}`,
    bundleId: 'bundle_1',
    productGid: `gid://shopify/Product/${gid}`,
    routineStep: step,
    position,
  };
}

function storedBundle(overrides: Partial<StoredBundle> = {}): StoredBundle {
  return {
    id: 'bundle_1',
    shop: SHOP,
    title: 'Routine set 1',
    handle: 'routine-set-1',
    status: 'DRAFT',
    createdAt: new Date('2026-09-08T00:00:00.000Z'),
    updatedAt: new Date('2026-09-08T00:00:00.000Z'),
    items: [
      storedItem('1', 'CLEANSE', 0),
      storedItem('2', 'TREAT', 1),
      storedItem('3', 'MOISTURIZE', 2),
    ],
    ...overrides,
  };
}

interface UpdateArgs {
  where: { id: string; shop?: string };
  data: {
    title?: string;
    status?: StoredBundle['status'];
    items?: {
      create: { productGid: string; routineStep: PrismaStep; position: number }[];
    };
  };
}

/**
 * A prisma double that actually stores what it is told.
 *
 * The editing tests are about what ends up in the row — which slots, in which
 * order, under which status — so a client that only records calls would leave
 * every assertion checking the test's own expectations. `$transaction` runs the
 * callback against the same object, which is enough to exercise the
 * delete-then-create sequence in `updateBundle`.
 */
function editablePrisma(rows: StoredBundle[]) {
  const store = rows.map((row) => ({ ...row, items: [...row.items] }));

  const client = {
    bundle: {
      findFirst: async ({ where }: { where: { id: string; shop: string } }) =>
        store.find(
          (row) => row.id === where.id && row.shop === where.shop,
        ) ?? null,

      update: async ({ where, data }: UpdateArgs) => {
        const row = store.find(
          (candidate) =>
            candidate.id === where.id &&
            (where.shop === undefined || candidate.shop === where.shop),
        );
        if (!row) throw new Error('update matched no row');

        if (data.title !== undefined) row.title = data.title;
        if (data.status !== undefined) row.status = data.status;
        if (data.items !== undefined) {
          row.items = data.items.create.map((item, index) => ({
            id: `new_item_${String(index)}`,
            bundleId: row.id,
            ...item,
          }));
        }
        row.updatedAt = new Date('2026-09-08T12:00:00.000Z');

        // Both call sites include `items` with `orderBy: { position: 'asc' }`,
        // and that ordering is the only thing that guarantees a routine reads
        // cleanse, treat, moisturize — rows come back in no particular order
        // otherwise. The double honours it rather than returning insertion
        // order, which would let a missing `orderBy` pass unnoticed here.
        return {
          ...row,
          items: [...row.items].toSorted((a, b) => a.position - b.position),
        };
      },

      deleteMany: async ({ where }: { where: { id: string; shop: string } }) => {
        const index = store.findIndex(
          (row) => row.id === where.id && row.shop === where.shop,
        );
        if (index === -1) return { count: 0 };
        store.splice(index, 1);
        return { count: 1 };
      },
    },

    bundleItem: {
      deleteMany: async ({ where }: { where: { bundleId: string } }) => {
        const row = store.find((candidate) => candidate.id === where.bundleId);
        const count = row?.items.length ?? 0;
        if (row) row.items = [];
        return { count };
      },
    },

    $transaction: async <T>(run: (tx: unknown) => Promise<T>) => run(client),
  };

  return { prisma: client as unknown as PrismaClient, store };
}

/** Answers `nodes(ids:)` from a fixed catalog, `null` for anything else. */
function fakeProductLookup(products: FakeProduct[]): {
  graphql: AdminGraphql;
  calls: AdminCall[];
} {
  const calls: AdminCall[] = [];
  const byGid = new Map(products.map((entry) => [entry.id, entry]));

  const graphql: AdminGraphql = async (document, variables) => {
    calls.push({ document, after: null });

    if (!document.includes('BundleProducts')) {
      throw new Error(`Unexpected document: ${document.slice(0, 40)}`);
    }

    const ids = (variables?.ids as string[] | undefined) ?? [];

    return {
      data: {
        nodes: ids.map((id) => byGid.get(id) ?? null),
      } as never,
    };
  };

  return { graphql, calls };
}

const CATALOG = [product('1', 'cleanse'), product('2', 'treat'), product('3', 'moisturize')];

describe('updateBundle', () => {
  it('renames a set without touching its slots', async () => {
    const { prisma, store } = editablePrisma([storedBundle()]);
    const { graphql } = fakeProductLookup(CATALOG);

    const bundle = await updateBundle(prisma, graphql, SHOP, 'bundle_1', {
      title: 'Nordic winter routine',
    });

    expect(bundle.title).toBe('Nordic winter routine');
    expect(bundle.items).toHaveLength(3);
    expect(store[0]?.items.map((item) => item.id)).toEqual([
      'item_CLEANSE',
      'item_TREAT',
      'item_MOISTURIZE',
    ]);
  });

  it('leaves the handle alone when the title changes', async () => {
    // The storefront links a routine set by its handle. Renaming is a
    // correction of wording; moving a URL is not, and conflating the two breaks
    // links a merchant may have shared.
    const { prisma } = editablePrisma([storedBundle()]);
    const { graphql } = fakeProductLookup(CATALOG);

    const bundle = await updateBundle(prisma, graphql, SHOP, 'bundle_1', {
      title: 'Renamed',
    });

    expect(bundle.handle).toBe('routine-set-1');
  });

  it('replaces the slots and orders them by routine step', async () => {
    const { prisma, store } = editablePrisma([storedBundle()]);
    const { graphql } = fakeProductLookup([
      ...CATALOG,
      product('9', 'moisturize'),
    ]);

    const bundle = await updateBundle(prisma, graphql, SHOP, 'bundle_1', {
      // Deliberately out of order: position is derived, not accepted.
      items: [
        { productGid: 'gid://shopify/Product/9', routineStep: 'moisturize' },
        { productGid: 'gid://shopify/Product/2', routineStep: 'treat' },
        { productGid: 'gid://shopify/Product/1', routineStep: 'cleanse' },
      ],
    });

    expect(bundle.items.map((item) => item.routineStep)).toEqual([
      'cleanse',
      'treat',
      'moisturize',
    ]);
    // Stored positions follow the step, not the order the client happened to
    // send its slots in.
    expect(
      store[0]?.items.map((item) => [item.routineStep, item.position]),
    ).toEqual([
      ['MOISTURIZE', 2],
      ['TREAT', 1],
      ['CLEANSE', 0],
    ]);
    expect(
      bundle.items.find((item) => item.routineStep === 'moisturize')?.title,
    ).toBe('Product 9');
  });

  it('accepts a draft whose product does not match the slot', async () => {
    // A draft is the merchant's workspace. The catalog checks belong to
    // activation, which is the state the storefront renders.
    const { prisma } = editablePrisma([storedBundle()]);
    const { graphql } = fakeProductLookup([
      product('1', 'treat'),
      product('2', 'treat'),
      product('3', 'moisturize'),
    ]);

    const bundle = await updateBundle(prisma, graphql, SHOP, 'bundle_1', {
      title: 'Work in progress',
    });

    expect(bundle.status).toBe('draft');
  });

  it('activates a set whose products all match', async () => {
    const { prisma } = editablePrisma([storedBundle()]);
    const { graphql } = fakeProductLookup(CATALOG);

    const bundle = await updateBundle(prisma, graphql, SHOP, 'bundle_1', {
      status: 'active',
    });

    expect(bundle.status).toBe('active');
  });

  it('refuses to activate a set holding a product with the wrong step', async () => {
    // The same condition `product.reconcile` demotes a bundle for. Accepting it
    // here would mean the app activated a set and then demoted it moments
    // later without the merchant doing anything.
    const { prisma, store } = editablePrisma([storedBundle()]);
    const { graphql } = fakeProductLookup([
      product('1', 'cleanse'),
      product('2', 'moisturize'),
      product('3', 'moisturize'),
    ]);

    await expect(
      updateBundle(prisma, graphql, SHOP, 'bundle_1', { status: 'active' }),
    ).rejects.toBeInstanceOf(BundleValidationError);

    expect(store[0]?.status).toBe('DRAFT');
  });

  it('refuses to activate a set holding a draft product', async () => {
    const { prisma } = editablePrisma([storedBundle()]);
    const { graphql } = fakeProductLookup([
      product('1', 'cleanse'),
      { ...product('2', 'treat'), status: 'DRAFT' },
      product('3', 'moisturize'),
    ]);

    try {
      await updateBundle(prisma, graphql, SHOP, 'bundle_1', {
        status: 'active',
      });
      expect.unreachable('updateBundle should have thrown');
    } catch (error) {
      const validation = error as BundleValidationError;
      expect(validation.detail.join(' ')).toContain('draft in Shopify');
    }
  });

  it('reports every unusable slot at once, not just the first', async () => {
    const { prisma } = editablePrisma([storedBundle()]);
    const { graphql } = fakeProductLookup([
      // Product 1 is missing from the catalog entirely: `nodes(ids:)` answers
      // null for a product deleted since it was added.
      { ...product('2', 'treat'), status: 'ARCHIVED' },
      product('3', 'cleanse'),
    ]);

    try {
      await updateBundle(prisma, graphql, SHOP, 'bundle_1', {
        status: 'active',
      });
      expect.unreachable('updateBundle should have thrown');
    } catch (error) {
      const validation = error as BundleValidationError;
      expect(validation.detail).toHaveLength(3);
      expect(validation.detail[0]).toContain('not in the catalog');
      expect(validation.detail[1]).toContain('archived');
      expect(validation.detail[2]).toContain('custom.routine_step');
    }
  });

  it('refuses to activate a set that is missing a step entirely', async () => {
    // The request schema requires all three, but the stored items may not have
    // them — an older row, or one edited by hand. Activating that would put a
    // two-step routine on the storefront.
    const { prisma } = editablePrisma([
      storedBundle({
        items: [storedItem('1', 'CLEANSE', 0), storedItem('2', 'TREAT', 1)],
      }),
    ]);
    const { graphql } = fakeProductLookup(CATALOG);

    try {
      await updateBundle(prisma, graphql, SHOP, 'bundle_1', {
        status: 'active',
      });
      expect.unreachable('updateBundle should have thrown');
    } catch (error) {
      expect((error as BundleValidationError).detail[0]).toContain(
        'no product for this step',
      );
    }
  });

  it('does not find a bundle belonging to another shop', async () => {
    const { prisma } = editablePrisma([
      storedBundle({ shop: 'someone-else.myshopify.com' }),
    ]);
    const { graphql } = fakeProductLookup(CATALOG);

    await expect(
      updateBundle(prisma, graphql, SHOP, 'bundle_1', { title: 'Mine now' }),
    ).rejects.toBeInstanceOf(BundleNotFoundError);
  });

  it('reads the catalog once for the whole set', async () => {
    // One `nodes(ids:)` call serves both the activation checks and the titles
    // in the response. Three calls would be three times the rate-limit cost for
    // the same data.
    const { prisma } = editablePrisma([storedBundle()]);
    const { graphql, calls } = fakeProductLookup(CATALOG);

    await updateBundle(prisma, graphql, SHOP, 'bundle_1', { status: 'active' });

    expect(calls).toHaveLength(1);
  });
});

describe('deleteBundle', () => {
  it('removes the set', async () => {
    const { prisma, store } = editablePrisma([storedBundle()]);

    await deleteBundle(prisma, SHOP, 'bundle_1');

    expect(store).toHaveLength(0);
  });

  it('refuses an id belonging to another shop', async () => {
    const { prisma, store } = editablePrisma([
      storedBundle({ shop: 'someone-else.myshopify.com' }),
    ]);

    await expect(deleteBundle(prisma, SHOP, 'bundle_1')).rejects.toBeInstanceOf(
      BundleNotFoundError,
    );
    expect(store).toHaveLength(1);
  });
});

describe('listCandidateProducts', () => {
  it('groups active products by the step they declare', async () => {
    const { graphql } = fakeCatalog([
      [
        product('1', 'cleanse'),
        product('2', 'cleanse'),
        product('3', 'treat'),
        product('4', null),
        product('5', 'exfoliate'),
      ],
    ]);

    const { candidates, scanned, exhausted } = await listCandidateProducts(
      graphql,
      noWait,
    );

    expect(candidates.map((entry) => entry.routineStep)).toEqual([
      'cleanse',
      'cleanse',
      'treat',
    ]);
    expect(scanned).toBe(5);
    expect(exhausted).toBe(true);
  });

  it('says the list is partial when the page cap stopped it', async () => {
    // What the editor renders as "showing the first N products". A picker that
    // silently truncates is how a merchant concludes a product cannot be added.
    const pages = Array.from({ length: 11 }, (_unused, page) => [
      product(`p${String(page)}`, 'cleanse'),
    ]);
    const { graphql } = fakeCatalog(pages);

    const { exhausted, scanned } = await listCandidateProducts(graphql, noWait);

    expect(exhausted).toBe(false);
    expect(scanned).toBe(10);
  });

  it('stops once every step has a full page of options', async () => {
    const many = [
      ...Array.from({ length: 100 }, (_unused, index) =>
        product(`c${String(index)}`, 'cleanse'),
      ),
      ...Array.from({ length: 100 }, (_unused, index) =>
        product(`t${String(index)}`, 'treat'),
      ),
      ...Array.from({ length: 100 }, (_unused, index) =>
        product(`m${String(index)}`, 'moisturize'),
      ),
      product('extra', 'cleanse'),
    ];
    const { graphql, calls } = fakeCatalog([many, [product('later', 'treat')]]);

    const { candidates } = await listCandidateProducts(graphql, noWait);

    expect(candidates).toHaveLength(300);
    expect(calls).toHaveLength(1);
  });
});
