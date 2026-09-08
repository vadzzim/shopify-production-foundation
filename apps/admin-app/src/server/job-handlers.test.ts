import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { AdminGraphql } from './admin-graphql';
import {
  JOB_HANDLERS,
  PermanentJobError,
  RetryLaterError,
  createCatalogExportHandler,
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

  it('clears the queued jobs that name the customer on customers/redact', async () => {
    // The only thing this schema retains about a customer is the id on their
    // own earlier compliance requests, sitting in `Job.payload`. Nothing
    // cascades to that table, so if this handler does not delete those rows
    // nothing ever does, and a request answered "nothing to redact" leaves the
    // customer id in the database it claimed to have cleared.
    const deleteMany = vi.fn(async () => ({ count: 1 }));

    const context = contextFor(
      jobFor('compliance.request', {
        topic: 'customers/redact',
        body: { shop_domain: SHOP, customer: { id: 191167 } },
      }),
      { job: { deleteMany } },
    );

    await handler(context);

    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        shop: SHOP,
        // Its own row survives: the worker marks it SUCCEEDED after this
        // returns, and that update fails on a row that is gone.
        id: { not: 'job-1' },
        payload: { path: ['body', 'customer', 'id'], equals: 191167 },
      },
    });
  });

  it('refuses a redaction request that names no customer', async () => {
    // Nothing to act on and nothing a retry improves. The dead-letter state is
    // where an undischargeable compliance request should end up, because it is
    // the one place a person looks.
    const context = contextFor(
      jobFor('compliance.request', {
        topic: 'customers/redact',
        body: { shop_domain: SHOP },
      }),
      { job: { deleteMany: async () => ({ count: 0 }) } },
    );

    await expect(handler(context)).rejects.toBeInstanceOf(PermanentJobError);
  });

  it('deletes everything for the shop on shop/redact', async () => {
    const bundle = vi.fn(async () => ({ count: 3 }));
    const session = vi.fn(async () => ({ count: 2 }));
    const webhookDelivery = vi.fn(async () => ({ count: 9 }));
    const job = vi.fn(async () => ({ count: 4 }));

    const context = contextFor(
      jobFor('compliance.request', {
        topic: 'shop/redact',
        body: { shop_domain: SHOP },
      }),
      {
        bundle: { deleteMany: bundle },
        session: { deleteMany: session },
        webhookDelivery: { deleteMany: webhookDelivery },
        job: { deleteMany: job },
      },
    );

    await handler(context);

    for (const spy of [bundle, session, webhookDelivery]) {
      expect(spy).toHaveBeenCalledWith({ where: { shop: SHOP } });
    }

    // The queue is included in the erasure, minus the row performing it.
    expect(job).toHaveBeenCalledWith({
      where: { shop: SHOP, id: { not: 'job-1' } },
    });
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

describe('catalog.export', () => {
  interface RecordedUpdate {
    where: { id: string };
    data: Record<string, unknown>;
  }

  function exportPrisma() {
    const updates: RecordedUpdate[] = [];

    const prisma = {
      job: {
        update: async (args: RecordedUpdate) => {
          updates.push(args);
          return { id: args.where.id };
        },
      },
    } as unknown as PrismaClient;

    return { prisma, updates };
  }

  /** A Shopify that starts an operation and then reports the given states. */
  function fakeShopify(states: { status: string; url?: string | null }[]) {
    const documents: string[] = [];
    let index = 0;

    const graphql: AdminGraphql = async (document) => {
      documents.push(document);

      if (document.includes('StartCatalogExport')) {
        return {
          data: {
            bulkOperationRunQuery: {
              bulkOperation: {
                id: 'gid://shopify/BulkOperation/1',
                status: 'CREATED',
              },
              userErrors: [],
            },
          } as never,
        };
      }

      const state = states[Math.min(index, states.length - 1)];
      index += 1;

      return {
        data: {
          bulkOperation: {
            id: 'gid://shopify/BulkOperation/1',
            status: state?.status ?? 'RUNNING',
            errorCode: null,
            objectCount: '0',
            url: state?.url ?? null,
            partialDataUrl: null,
            completedAt: '2026-09-08T12:00:00.000Z',
          },
        } as never,
      };
    };

    return { graphql, documents };
  }

  /**
   * The handler with its polling given a clock that does not tick.
   *
   * `pollBudgetMs: 0` makes the first status check the only one: the point of
   * these tests is what the handler does with each answer, and the waiting
   * itself is covered in catalog-export.test.ts.
   */
  const handler = createCatalogExportHandler({
    sleep: async () => {},
    pollIntervalMs: 0,
    pollBudgetMs: 0,
  });

  const started = (documents: string[]) =>
    documents.filter((document) => document.includes('StartCatalogExport'))
      .length;

  it('is registered for the kind the API enqueues', () => {
    // The tests below drive an injected copy so they do not really wait thirty
    // seconds; this is the line that says the registry has one at all.
    expect(JOB_HANDLERS['catalog.export']).toBeTypeOf('function');
  });

  it('records the operation id before it starts polling', async () => {
    // The whole reason this handler is safe to retry. Starting a bulk operation
    // is not idempotent, so the id has to outlive the attempt that created it —
    // and it is written before any polling, which is the window a crash would
    // otherwise land in.
    const job = jobFor('catalog.export', {});
    const { prisma, updates } = exportPrisma();
    const { graphql } = fakeShopify([{ status: 'RUNNING' }]);

    await expect(
      handler(contextFor(job, prisma, graphql)),
    ).rejects.toBeInstanceOf(RetryLaterError);

    expect(updates[0]?.data).toEqual({
      payload: { bulkOperationId: 'gid://shopify/BulkOperation/1' },
    });
  });

  it('resumes the operation a previous attempt started', async () => {
    const job = jobFor('catalog.export', {
      bulkOperationId: 'gid://shopify/BulkOperation/1',
    });
    const { prisma } = exportPrisma();
    const { graphql, documents } = fakeShopify([{ status: 'RUNNING' }]);

    await expect(
      handler(contextFor(job, prisma, graphql)),
    ).rejects.toBeInstanceOf(RetryLaterError);

    // A retry that re-ran the mutation would leave two exports of the same
    // catalog running against the same rate-limit bucket.
    expect(started(documents)).toBe(0);
  });

  it('asks to be run again later rather than failing while it waits', async () => {
    const job = jobFor('catalog.export', {
      bulkOperationId: 'gid://shopify/BulkOperation/1',
    });
    const { prisma } = exportPrisma();
    const { graphql } = fakeShopify([{ status: 'RUNNING' }]);

    try {
      await handler(contextFor(job, prisma, graphql));
      expect.unreachable('the handler should have asked for a retry');
    } catch (error) {
      const later = error as RetryLaterError;
      expect(later).toBeInstanceOf(RetryLaterError);
      expect(later.runAt.getTime()).toBeGreaterThan(Date.now());
    }
  });

  it('stores the report when the operation completes', async () => {
    const job = jobFor('catalog.export', {
      bulkOperationId: 'gid://shopify/BulkOperation/1',
    });
    const { prisma, updates } = exportPrisma();
    const { graphql } = fakeShopify([
      { status: 'COMPLETED', url: null },
    ]);

    await handler(contextFor(job, prisma, graphql));

    expect(updates).toHaveLength(1);
    expect(updates[0]?.data.result).toMatchObject({
      bulkOperationId: 'gid://shopify/BulkOperation/1',
      objectCount: 0,
    });
  });

  it('forgets a failed operation so the retry starts a fresh one', async () => {
    // Polling a FAILED operation again would answer the same thing forever.
    const job = jobFor('catalog.export', {
      bulkOperationId: 'gid://shopify/BulkOperation/1',
    });
    const { prisma, updates } = exportPrisma();
    const { graphql } = fakeShopify([{ status: 'FAILED' }]);

    await expect(
      handler(contextFor(job, prisma, graphql)),
    ).rejects.toThrow('ended as FAILED');

    expect(updates[0]?.data).toEqual({ payload: {} });
  });

  it('refuses a payload that is not a catalog export', async () => {
    const job = jobFor('catalog.export', { bulkOperationId: 42 });
    const { prisma } = exportPrisma();
    const { graphql } = fakeShopify([]);

    await expect(
      handler(contextFor(job, prisma, graphql)),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });
});
