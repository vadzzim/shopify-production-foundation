import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { AdminGraphql } from './admin-graphql';
import {
  JOB_HANDLERS,
  PermanentJobError,
  type HandlerContext,
} from './job-handlers';
import type { Logger, LogFields } from './logger';
import type { QueueJob } from './queue';

/**
 * The handlers, against fakes.
 *
 * Everything asserted here is a decision about *what should happen* — a bundle
 * demoted, sessions cleared, bundles deliberately not cleared — rather than
 * about SQL. The database-level guarantees are in the integration tests; these
 * are the domain rules, and they are the ones a reviewer six months from now
 * will want stated somewhere they cannot silently change.
 */

const SHOP = 'ecorn-oj1cb5ll.myshopify.com';

interface Recorded {
  level: string;
  message: string;
  fields?: LogFields;
}

function recordingLog(): { log: Logger; lines: Recorded[] } {
  const lines: Recorded[] = [];

  const make = (): Logger => {
    const at =
      (level: string) =>
      (message: string, fields?: LogFields): void => {
        lines.push({ level, message, ...(fields ? { fields } : {}) });
      };

    return {
      fatal: at('fatal'),
      error: at('error'),
      warn: at('warn'),
      info: at('info'),
      debug: at('debug'),
      trace: at('trace'),
      child: () => make(),
    };
  };

  return { log: make(), lines };
}

function jobFor(kind: QueueJob['kind'], payload: unknown): QueueJob {
  return {
    id: 'job-1',
    shop: SHOP,
    kind,
    payload,
    attempts: 1,
    maxAttempts: 5,
    correlationId: 'delivery-1',
    webhookId: 'delivery-1',
  };
}

function contextFor(
  job: QueueJob,
  prisma: unknown,
  graphql?: AdminGraphql,
): HandlerContext & { lines: Recorded[] } {
  const { log, lines } = recordingLog();

  return {
    job,
    prisma: prisma as PrismaClient,
    graphqlFor: async () => {
      if (!graphql) throw new Error('This handler must not call the Admin API.');
      return graphql;
    },
    log,
    lines,
  };
}

describe('order.received', () => {
  const handler = JOB_HANDLERS['order.received'];

  it('resolves the bundle ids the storefront wrote on the line items', async () => {
    const findMany = vi.fn(async () => [{ id: 'bundle-1' }]);
    const context = contextFor(
      jobFor('order.received', {
        topic: 'orders/create',
        body: {
          name: '#1001',
          line_items: [
            { properties: [{ name: '_bundle_id', value: 'bundle-1' }] },
            { properties: [{ name: '_bundle_id', value: 'bundle-1' }] },
          ],
        },
      }),
      { bundle: { findMany } },
    );

    await handler(context);

    // Scoped to the shop as well as the id: one deployment serves many stores,
    // and an id looked up without its shop is a cross-tenant read.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shop: SHOP, id: { in: ['bundle-1'] } },
      }),
    );
  });

  it('warns about a bundle the order names and this app does not have', async () => {
    const context = contextFor(
      jobFor('order.received', {
        topic: 'orders/create',
        body: {
          name: '#1002',
          line_items: [
            { properties: [{ name: '_bundle_id', value: 'bundle-gone' }] },
          ],
        },
      }),
      { bundle: { findMany: async () => [] } },
    );

    await handler(context);

    const warning = context.lines.find((line) => line.level === 'warn');
    expect(warning?.fields?.unknownBundleIds).toEqual(['bundle-gone']);
  });

  it('does nothing for an order with no bundle line items', async () => {
    const findMany = vi.fn(async () => []);
    const context = contextFor(
      jobFor('order.received', {
        topic: 'orders/create',
        body: { name: '#1003', line_items: [{ properties: [] }] },
      }),
      { bundle: { findMany } },
    );

    await handler(context);

    expect(findMany).not.toHaveBeenCalled();
  });

  it('sends a payload of the wrong shape to the dead-letter state', async () => {
    // A retry cannot make a malformed payload parse. Spending four more
    // attempts on it only delays the sync log showing anyone it is broken.
    const context = contextFor(
      jobFor('order.received', { nonsense: true }),
      {},
    );

    await expect(handler(context)).rejects.toBeInstanceOf(PermanentJobError);
  });
});

describe('product.reconcile', () => {
  const handler = JOB_HANDLERS['product.reconcile'];

  const productPayload = {
    topic: 'products/update',
    body: { admin_graphql_api_id: 'gid://shopify/Product/1' },
  };

  function prismaWith(items: { bundleId: string; routineStep: string }[]) {
    return {
      bundleItem: { findMany: async () => items },
      bundle: { updateMany: vi.fn(async () => ({ count: 1 })) },
    };
  }

  it('makes no Admin API call when no active bundle uses the product', async () => {
    // The common case by far, and the one where an extra call per webhook would
    // be a rate-limit bill for nothing.
    const context = contextFor(
      jobFor('product.reconcile', productPayload),
      prismaWith([]),
      // No graphql: the fake context throws if the handler asks for one.
    );

    await expect(handler(context)).resolves.toBeUndefined();
  });

  it('leaves a bundle alone when the product still matches its slot', async () => {
    const prisma = prismaWith([
      { bundleId: 'bundle-1', routineStep: 'CLEANSE' },
    ]);
    const graphql: AdminGraphql = async () => ({
      data: {
        product: {
          id: 'gid://shopify/Product/1',
          title: 'Fjord Cleansing Balm',
          status: 'ACTIVE',
          routineStep: { value: 'cleanse' },
        },
      } as never,
    });

    await handler(
      contextFor(jobFor('product.reconcile', productPayload), prisma, graphql),
    );

    expect(prisma.bundle.updateMany).not.toHaveBeenCalled();
  });

  it('demotes a bundle when the merchant moves the product to another step', async () => {
    const prisma = prismaWith([
      { bundleId: 'bundle-1', routineStep: 'CLEANSE' },
    ]);
    const graphql: AdminGraphql = async () => ({
      data: {
        product: {
          id: 'gid://shopify/Product/1',
          title: 'Fjord Cleansing Balm',
          status: 'ACTIVE',
          // Was cleanse, now treat: the bundle's cleanse slot holds a product
          // that is no longer a cleanser.
          routineStep: { value: 'treat' },
        },
      } as never,
    });

    const context = contextFor(
      jobFor('product.reconcile', productPayload),
      prisma,
      graphql,
    );
    await handler(context);

    expect(prisma.bundle.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['bundle-1'] }, shop: SHOP, status: 'ACTIVE' },
      data: { status: 'DRAFT' },
    });
  });

  it('demotes a bundle when the product is archived', async () => {
    const prisma = prismaWith([
      { bundleId: 'bundle-1', routineStep: 'CLEANSE' },
    ]);
    const graphql: AdminGraphql = async () => ({
      data: {
        product: {
          id: 'gid://shopify/Product/1',
          title: 'Fjord Cleansing Balm',
          status: 'ARCHIVED',
          routineStep: { value: 'cleanse' },
        },
      } as never,
    });

    await handler(
      contextFor(jobFor('product.reconcile', productPayload), prisma, graphql),
    );

    expect(prisma.bundle.updateMany).toHaveBeenCalled();
  });

  it('demotes a bundle when the product has been deleted', async () => {
    const prisma = prismaWith([
      { bundleId: 'bundle-1', routineStep: 'CLEANSE' },
    ]);
    // `product(id:)` returns null for something this token can no longer see.
    const graphql: AdminGraphql = async () => ({
      data: { product: null } as never,
    });

    await handler(
      contextFor(jobFor('product.reconcile', productPayload), prisma, graphql),
    );

    expect(prisma.bundle.updateMany).toHaveBeenCalled();
  });

  it('accepts a payload that carries only the numeric id', async () => {
    // Shopify's REST-shaped webhook payloads carry `id` and usually, but not
    // always, `admin_graphql_api_id`.
    const prisma = prismaWith([]);

    await expect(
      handler(
        contextFor(
          jobFor('product.reconcile', {
            topic: 'products/update',
            body: { id: 1 },
          }),
          prisma,
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects a payload with no product identifier at all', async () => {
    await expect(
      handler(
        contextFor(
          jobFor('product.reconcile', {
            topic: 'products/update',
            body: { title: 'no id here' },
          }),
          prismaWith([]),
        ),
      ),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });
});

describe('shop.cleanup', () => {
  const handler = JOB_HANDLERS['shop.cleanup'];

  it('clears the sessions, whose tokens have just been revoked', async () => {
    const deleteMany = vi.fn(async () => ({ count: 2 }));
    const context = contextFor(
      jobFor('shop.cleanup', {
        topic: 'app/uninstalled',
        body: { id: 1, domain: SHOP },
      }),
      { session: { deleteMany } },
    );

    await handler(context);

    expect(deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP } });
  });

  it('keeps the bundles: uninstalling is not asking to be forgotten', async () => {
    // A merchant who reinstalls next week expects their routine sets to still
    // be there. Deletion arrives separately, as shop/redact, 48 hours later.
    const bundleDeleteMany = vi.fn(async () => ({ count: 0 }));
    const context = contextFor(
      jobFor('shop.cleanup', { topic: 'app/uninstalled', body: {} }),
      {
        session: { deleteMany: async () => ({ count: 1 }) },
        bundle: { deleteMany: bundleDeleteMany },
      },
    );

    await handler(context);

    expect(bundleDeleteMany).not.toHaveBeenCalled();
  });

  it('makes no Admin API call, since the token is already gone', async () => {
    // The fake context throws if `graphqlFor` is called, which is the assertion.
    const context = contextFor(
      jobFor('shop.cleanup', { topic: 'app/uninstalled', body: {} }),
      { session: { deleteMany: async () => ({ count: 1 }) } },
    );

    await expect(handler(context)).resolves.toBeUndefined();
  });
});

describe('compliance.request', () => {
  const handler = JOB_HANDLERS['compliance.request'];

  it('answers a customer data request without touching the database', async () => {
    // There is no customer personal data in this schema, so there is nothing to
    // gather. That is only a defensible answer while it stays true — see the
    // schema test below.
    const context = contextFor(
      jobFor('compliance.request', {
        topic: 'customers/data_request',
        body: { shop_domain: SHOP, customer: { id: 191167 } },
      }),
      {},
    );

    await handler(context);

    expect(context.lines.some((line) => line.level === 'info')).toBe(true);
  });

  it('answers a customer redaction request with nothing to redact', async () => {
    const context = contextFor(
      jobFor('compliance.request', {
        topic: 'customers/redact',
        body: { shop_domain: SHOP, customer: { id: 191167 } },
      }),
      {},
    );

    await expect(handler(context)).resolves.toBeUndefined();
  });

  it('deletes everything for the shop on shop/redact', async () => {
    const bundle = vi.fn(async () => ({ count: 3 }));
    const session = vi.fn(async () => ({ count: 2 }));
    const webhookDelivery = vi.fn(async () => ({ count: 9 }));

    const context = contextFor(
      jobFor('compliance.request', {
        topic: 'shop/redact',
        body: { shop_domain: SHOP },
      }),
      {
        bundle: { deleteMany: bundle },
        session: { deleteMany: session },
        webhookDelivery: { deleteMany: webhookDelivery },
      },
    );

    await handler(context);

    for (const spy of [bundle, session, webhookDelivery]) {
      expect(spy).toHaveBeenCalledWith({ where: { shop: SHOP } });
    }
  });
});

describe('inventory.push', () => {
  const handler = JOB_HANDLERS['inventory.push'];

  it('uses the job id as the idempotency key', async () => {
    const graphql: AdminGraphql = vi.fn(async () => ({
      data: {
        inventorySetQuantities: {
          inventoryAdjustmentGroup: {
            createdAt: '2026-09-08T00:00:00Z',
            reason: 'Inventory correction',
            referenceDocumentUri: null,
            changes: [],
          },
          userErrors: [],
        },
      } as never,
    }));

    await handler(
      contextFor(
        jobFor('inventory.push', {
          inventoryItemId: 'gid://shopify/InventoryItem/1',
          locationId: 'gid://shopify/Location/1',
          quantity: 40,
        }),
        {},
        graphql,
      ),
    );

    const call = vi.mocked(graphql).mock.calls[0];
    if (!call) throw new Error('The inventory mutation was never sent.');
    expect(call[1]?.idempotencyKey).toBe('job-1');
  });

  it('rejects a payload that names a variant instead of an inventory item', async () => {
    // The mistake this schema exists to catch: stock lives on the
    // InventoryItem × Location pair, and a variant gid is not one.
    await expect(
      handler(
        contextFor(
          jobFor('inventory.push', {
            inventoryItemId: 'gid://shopify/ProductVariant/1',
            locationId: 'gid://shopify/Location/1',
            quantity: 40,
          }),
          {},
        ),
      ),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });

  it('rejects a negative quantity', async () => {
    await expect(
      handler(
        contextFor(
          jobFor('inventory.push', {
            inventoryItemId: 'gid://shopify/InventoryItem/1',
            locationId: 'gid://shopify/Location/1',
            quantity: -1,
          }),
          {},
        ),
      ),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });
});
