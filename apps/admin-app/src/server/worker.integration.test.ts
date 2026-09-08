import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AdminGraphql } from './admin-graphql';
import type { Logger } from './logger';
import { enqueue } from './queue';
import {
  cleanTestData,
  createTestPrisma,
  hasDatabase,
  testShop,
} from './test-database';
import { createWorker } from './worker';

/**
 * The worker's tick, against a real queue.
 *
 * Retries, the attempt budget and the dead-letter transition are all state
 * machines over rows, and a fake `prisma` would only confirm that the right
 * method name was called. What matters is the row's status afterwards, which is
 * what these assert.
 */

const SHOP = testShop('worker');

const silent: Logger = {
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  child: () => silent,
};

describe.skipIf(!hasDatabase)('the worker', () => {
  let prisma: PrismaClient;

  const graphqlFor = async (): Promise<AdminGraphql> => {
    throw new Error('This test must not reach the Admin API.');
  };

  beforeAll(() => {
    prisma = createTestPrisma();
  });

  afterEach(async () => {
    await cleanTestData(prisma, SHOP);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function worker(overrides: Partial<Parameters<typeof createWorker>[0]> = {}) {
    return createWorker({
      prisma,
      graphqlFor,
      log: silent,
      batchSize: 5,
      ...overrides,
    });
  }

  it('runs a queued job and marks it succeeded', async () => {
    const id = await enqueue(prisma, {
      shop: SHOP,
      kind: 'order.received',
      payload: { topic: 'orders/create', body: { name: '#1001' } },
      correlationId: 'c1',
    });

    // `bundle.findMany` is a real query against a shop with no bundles, so the
    // handler takes its "no bundle line items" path.
    expect(await worker().tick()).toBe(1);

    const row = await prisma.job.findFirstOrThrow({ where: { id } });
    expect(row.status).toBe('SUCCEEDED');
    expect(row.finishedAt).not.toBeNull();
    expect(row.lockedBy).toBeNull();
  });

  it('schedules a retry with backoff when a job throws', async () => {
    // `products/update` with no product identifier is a permanent failure, so
    // this uses a payload the handler accepts and a graphql call that fails —
    // the transient case, which is the one that should be retried.
    const id = await enqueue(prisma, {
      shop: SHOP,
      kind: 'inventory.push',
      payload: {
        inventoryItemId: 'gid://shopify/InventoryItem/1',
        locationId: 'gid://shopify/Location/1',
        quantity: 10,
      },
      correlationId: 'c1',
    });

    const failing = worker({
      graphqlFor: async () => async () => ({
        errors: { networkStatusCode: 503, message: 'Service Unavailable' },
      }),
    });

    await failing.tick();

    const row = await prisma.job.findFirstOrThrow({ where: { id } });
    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('503');
    // Pushed into the future rather than left runnable, so the next tick does
    // not hammer a dependency that is down.
    expect(row.runAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('reaches the dead-letter state after the attempt budget runs out', async () => {
    const id = await enqueue(prisma, {
      shop: SHOP,
      kind: 'inventory.push',
      payload: {
        inventoryItemId: 'gid://shopify/InventoryItem/1',
        locationId: 'gid://shopify/Location/1',
        quantity: 10,
      },
      correlationId: 'c1',
      maxAttempts: 2,
    });

    const failing = worker({
      graphqlFor: async () => async () => ({
        errors: { networkStatusCode: 503, message: 'Service Unavailable' },
      }),
    });

    await failing.tick();
    // Make the scheduled retry runnable now instead of waiting out the backoff.
    await prisma.job.update({ where: { id }, data: { runAt: new Date() } });
    await failing.tick();

    const row = await prisma.job.findFirstOrThrow({ where: { id } });
    expect(row.status).toBe('DEAD');
    expect(row.attempts).toBe(2);
    expect(row.finishedAt).not.toBeNull();
  });

  it('spends no retries on a failure that cannot be fixed by retrying', async () => {
    // A malformed payload is the same on the fifth attempt as on the first, and
    // four more attempts only delay the sync log showing anyone it is broken.
    const id = await enqueue(prisma, {
      shop: SHOP,
      kind: 'inventory.push',
      payload: { nothing: 'like the schema' },
      correlationId: 'c1',
      maxAttempts: 5,
    });

    await worker().tick();

    const row = await prisma.job.findFirstOrThrow({ where: { id } });
    expect(row.status).toBe('DEAD');
    expect(row.attempts).toBe(1);
  });

  it('sends a job whose kind has no handler straight to the dead-letter state', async () => {
    // A kind written by a newer deploy, or by hand in Prisma Studio. The code
    // to run it does not exist, and retrying cannot conjure it.
    const id = await enqueue(prisma, {
      shop: SHOP,
      // The column is a plain string; the enum is a compile-time contract only.
      kind: 'never.registered' as 'order.received',
      payload: {},
      correlationId: 'c1',
    });

    await worker().tick();

    const row = await prisma.job.findFirstOrThrow({ where: { id } });
    expect(row.status).toBe('DEAD');
    expect(row.lastError).toContain('No handler registered');
  });

  it('carries the correlation id from the row into the job’s log lines', async () => {
    // The property the whole logging design exists for: the id minted when the
    // delivery arrived is still attached when the work runs, in a later tick and
    // possibly a later process.
    const child = vi.fn(() => silent);
    const log: Logger = { ...silent, child };

    await enqueue(prisma, {
      shop: SHOP,
      kind: 'order.received',
      payload: { topic: 'orders/create', body: {} },
      correlationId: 'delivery-xyz',
    });

    await worker({ log }).tick();

    expect(child).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'delivery-xyz', shop: SHOP }),
    );
  });

  it('keeps polling after a tick fails outright', async () => {
    // The database being unreachable must not end the loop: it coming back
    // should resume work without a restart.
    const broken = createWorker({
      prisma: {
        job: {
          updateMany: () => {
            throw new Error('connection refused');
          },
        },
        $queryRaw: () => {
          throw new Error('connection refused');
        },
      } as unknown as PrismaClient,
      graphqlFor,
      log: silent,
      pollIntervalMs: 1,
      sleep: async () => {
        broken.stop();
      },
    });

    // Resolving at all is the assertion: an unhandled throw would reject here.
    await expect(broken.start()).resolves.toBeUndefined();
  });
});
