import type { PrismaClient } from '@prisma/client';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { AdminGraphql } from './admin-graphql';
import { createApiRouter } from './api-router';

/**
 * The API through real HTTP.
 *
 * The router takes its dependencies as arguments, so these tests need neither a
 * tunnel, nor an installed app, nor a database — which is what makes it
 * practical to assert on the failure paths, and the failure paths are the half
 * a manual click-through never covers.
 */

const SHOP = 'ecorn-oj1cb5ll.myshopify.com';

const bundleRow = {
  id: 'bundle_1',
  shop: SHOP,
  title: 'Routine set 1',
  handle: 'routine-set-1',
  status: 'DRAFT' as const,
  createdAt: new Date('2026-09-08T00:00:00.000Z'),
  updatedAt: new Date('2026-09-08T00:00:00.000Z'),
  items: [
    {
      id: 'item_1',
      bundleId: 'bundle_1',
      productGid: 'gid://shopify/Product/1',
      routineStep: 'CLEANSE' as const,
      position: 0,
    },
    {
      id: 'item_2',
      bundleId: 'bundle_1',
      productGid: 'gid://shopify/Product/2',
      routineStep: 'TREAT' as const,
      position: 1,
    },
  ],
};

function prismaReturning(rows: unknown[]): PrismaClient {
  return {
    bundle: {
      findMany: async () => rows,
    },
  } as unknown as PrismaClient;
}

function appWith(prisma: PrismaClient, graphql: AdminGraphql) {
  const app = express();
  app.use('/api', createApiRouter({ prisma, contextFor: () => ({ shop: SHOP, graphql }) }));
  return app;
}

describe('GET /api/bundles', () => {
  it('merges stored bundles with live product titles', async () => {
    const graphql: AdminGraphql = async () => ({
      data: {
        nodes: [
          {
            id: 'gid://shopify/Product/1',
            title: 'Fjord Cleansing Balm',
            status: 'ACTIVE',
            routineStep: { value: 'cleanse' },
          },
          {
            id: 'gid://shopify/Product/2',
            title: 'Cloudberry Bright Serum',
            status: 'DRAFT',
            routineStep: { value: 'treat' },
          },
        ],
      } as never,
    });

    const response = await request(appWith(prismaReturning([bundleRow]), graphql))
      .get('/api/bundles')
      .expect(200);

    expect(response.body.bundles).toHaveLength(1);
    expect(response.body.bundles[0]).toMatchObject({
      id: 'bundle_1',
      status: 'draft',
      items: [
        { routineStep: 'cleanse', title: 'Fjord Cleansing Balm' },
        { routineStep: 'treat', title: 'Cloudberry Bright Serum' },
      ],
    });
  });

  it('reports a product Shopify no longer returns as missing, not as a stale title', async () => {
    // `nodes(ids:)` answers null for anything the token cannot resolve — a
    // deleted product, most often. Passing that through is what lets the screen
    // say "no longer in the catalog" instead of showing a name that is gone.
    const graphql: AdminGraphql = async () => ({
      data: { nodes: [null, null] } as never,
    });

    const response = await request(appWith(prismaReturning([bundleRow]), graphql))
      .get('/api/bundles')
      .expect(200);

    expect(response.body.bundles[0].items[0]).toMatchObject({
      title: null,
      productStatus: null,
    });
  });

  it('answers 502 with Shopify’s own message when the Admin API fails', async () => {
    // This is the shape `adminGraphqlFor` produces from a thrown SDK error —
    // the SDK throws rather than returning `errors`, and the translation is
    // covered in admin-graphql.test.ts.
    const graphql: AdminGraphql = async () => ({
      errors: {
        networkStatusCode: 503,
        graphQLErrors: [{ message: 'Internal error' }],
      },
    });

    const response = await request(appWith(prismaReturning([bundleRow]), graphql))
      .get('/api/bundles')
      .expect(502);

    // 502, not 500: the app worked and the upstream did not, and the detail
    // says which upstream and why.
    expect(response.body.error.code).toBe('shopify_api');
    expect(response.body.error.detail).toEqual(
      expect.arrayContaining(['HTTP 503', 'Internal error']),
    );
  });
});

describe('POST /api/store/prepare', () => {
  it('passes userErrors through to the client instead of swallowing them', async () => {
    const graphql: AdminGraphql = async (document) => {
      if (document.includes('MetaobjectDefinitionByType')) {
        return {
          data: {
            metaobjectDefinitionByType: {
              id: 'gid://shopify/MetaobjectDefinition/1',
            },
          } as never,
        };
      }

      return {
        data: {
          metafieldDefinitionCreate: {
            createdDefinition: null,
            userErrors: [
              {
                field: ['definition', 'namespace'],
                message: 'Namespace is reserved',
                code: 'RESERVED_NAMESPACE_KEY',
              },
            ],
          },
        } as never,
      };
    };

    const response = await request(appWith(prismaReturning([]), graphql))
      .post('/api/store/prepare')
      .expect(502);

    expect(response.body.error.detail).toEqual([
      'definition.namespace: Namespace is reserved [RESERVED_NAMESPACE_KEY]',
    ]);
  });
});

describe('POST /api/bundles/starter', () => {
  it('explains which routine step the catalog cannot fill', async () => {
    const graphql: AdminGraphql = async () => ({
      data: {
        products: {
          nodes: [
            {
              id: 'gid://shopify/Product/1',
              title: 'Fjord Cleansing Balm',
              status: 'ACTIVE',
              routineStep: { value: 'cleanse' },
            },
          ],
          // One page, and the last one — so the message may say the catalog was
          // read in full. See bundles.test.ts for the paging behaviour itself.
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      } as never,
    });

    const response = await request(appWith(prismaReturning([]), graphql))
      .post('/api/bundles/starter')
      .expect(422);

    expect(response.body.error.code).toBe('validation');
    expect(response.body.error.detail.join(' ')).toContain('treat');
    expect(response.body.error.detail.join(' ')).toContain('moisturize');
  });
});

describe('unknown endpoints', () => {
  it('answer with the same error envelope as everything else', async () => {
    const graphql: AdminGraphql = async () => ({ data: {} as never });

    const response = await request(appWith(prismaReturning([]), graphql))
      .get('/api/nope')
      .expect(404);

    expect(response.body).toEqual({
      error: { code: 'not_found', message: 'No such endpoint.' },
    });
  });
});

describe('PATCH /api/bundles/:id', () => {
  it('names the field it refused rather than answering "invalid request"', async () => {
    const graphql: AdminGraphql = async () => ({ data: {} as never });

    const response = await request(appWith(prismaReturning([]), graphql))
      .patch('/api/bundles/bundle_1')
      .send({
        items: [
          { productGid: 'gid://shopify/Product/1', routineStep: 'cleanse' },
          { productGid: 'gid://shopify/Product/2', routineStep: 'treat' },
        ],
      })
      .expect(422);

    expect(response.body.error.code).toBe('validation');
    expect(response.body.error.detail.join(' ')).toContain('items');
    expect(response.body.error.detail.join(' ')).toContain('moisturize');
  });

  it('refuses a body that changes nothing', async () => {
    // A 200 here would tell the caller a change was applied.
    const graphql: AdminGraphql = async () => ({ data: {} as never });

    await request(appWith(prismaReturning([]), graphql))
      .patch('/api/bundles/bundle_1')
      .send({})
      .expect(422);
  });

  it('answers 404 for an id this shop does not have', async () => {
    const prisma = {
      bundle: { findFirst: async () => null },
    } as unknown as PrismaClient;
    const graphql: AdminGraphql = async () => ({ data: {} as never });

    const response = await request(appWith(prisma, graphql))
      .patch('/api/bundles/bundle_1')
      .send({ title: 'Mine now' })
      .expect(404);

    // Not 403, and the message does not say whether the row exists elsewhere:
    // "that id exists, just not for you" is a cross-tenant disclosure.
    expect(response.body.error.code).toBe('not_found');
  });

  it('returns the updated set, with titles read live', async () => {
    const stored = {
      ...bundleRow,
      items: [
        ...bundleRow.items,
        {
          id: 'item_3',
          bundleId: 'bundle_1',
          productGid: 'gid://shopify/Product/3',
          routineStep: 'MOISTURIZE' as const,
          position: 2,
        },
      ],
    };

    const prisma = {
      bundle: {
        findFirst: async () => stored,
        update: async () => ({ ...stored, title: 'Nordic winter routine' }),
      },
      bundleItem: { deleteMany: async () => ({ count: 3 }) },
      $transaction: async (run: (tx: unknown) => Promise<unknown>) =>
        run(prisma),
    } as unknown as PrismaClient;

    const graphql: AdminGraphql = async () => ({
      data: {
        nodes: [
          {
            id: 'gid://shopify/Product/1',
            title: 'Fjord Cleansing Balm',
            status: 'ACTIVE',
            routineStep: { value: 'cleanse' },
          },
          {
            id: 'gid://shopify/Product/2',
            title: 'Cloudberry Bright Serum',
            status: 'ACTIVE',
            routineStep: { value: 'treat' },
          },
          {
            id: 'gid://shopify/Product/3',
            title: 'Birch Sap Cream',
            status: 'ACTIVE',
            routineStep: { value: 'moisturize' },
          },
        ],
      } as never,
    });

    const response = await request(appWith(prisma, graphql))
      .patch('/api/bundles/bundle_1')
      .send({ title: 'Nordic winter routine' })
      .expect(200);

    expect(response.body.bundle).toMatchObject({
      title: 'Nordic winter routine',
      items: [
        { routineStep: 'cleanse', title: 'Fjord Cleansing Balm' },
        { routineStep: 'treat', title: 'Cloudberry Bright Serum' },
        { routineStep: 'moisturize', title: 'Birch Sap Cream' },
      ],
    });
  });
});

describe('DELETE /api/bundles/:id', () => {
  it('answers 204 with no body', async () => {
    const prisma = {
      bundle: { deleteMany: async () => ({ count: 1 }) },
    } as unknown as PrismaClient;
    const graphql: AdminGraphql = async () => ({ data: {} as never });

    const response = await request(appWith(prisma, graphql))
      .delete('/api/bundles/bundle_1')
      .expect(204);

    expect(response.body).toEqual({});
  });

  it('answers 404 when the delete matched nothing', async () => {
    const prisma = {
      bundle: { deleteMany: async () => ({ count: 0 }) },
    } as unknown as PrismaClient;
    const graphql: AdminGraphql = async () => ({ data: {} as never });

    await request(appWith(prisma, graphql))
      .delete('/api/bundles/bundle_1')
      .expect(404);
  });
});

describe('GET /api/catalog/candidates', () => {
  it('returns the products per step, and says whether the list is complete', async () => {
    const graphql: AdminGraphql = async () => ({
      data: {
        products: {
          nodes: [
            {
              id: 'gid://shopify/Product/1',
              title: 'Fjord Cleansing Balm',
              status: 'ACTIVE',
              routineStep: { value: 'cleanse' },
            },
            {
              id: 'gid://shopify/Product/9',
              title: 'Unassigned Product',
              status: 'ACTIVE',
              routineStep: null,
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      } as never,
    });

    const response = await request(appWith(prismaReturning([]), graphql))
      .get('/api/catalog/candidates')
      .expect(200);

    expect(response.body.candidates).toEqual([
      {
        productGid: 'gid://shopify/Product/1',
        title: 'Fjord Cleansing Balm',
        routineStep: 'cleanse',
        productStatus: 'ACTIVE',
      },
    ]);
    expect(response.body).toMatchObject({ scanned: 2, exhausted: true });
  });
});
