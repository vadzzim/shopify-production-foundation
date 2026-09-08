import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import type { AdminGraphql } from './admin-graphql';
import { BundleValidationError, createStarterBundle } from './bundles';

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

function fakePrisma(): PrismaClient {
  return {
    bundle: {
      count: async () => 0,
      create: async ({ data }: CreateArgs) => ({
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
      }),
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
