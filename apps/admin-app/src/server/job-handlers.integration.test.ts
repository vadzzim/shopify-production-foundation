import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { JOB_HANDLERS, type HandlerContext } from './job-handlers';
import { logger } from './logger';
import { enqueue, type QueueJob } from './queue';
import {
  cleanTestData,
  createTestPrisma,
  hasDatabase,
  testShop,
} from './test-database';

/**
 * The redaction handlers, against PostgreSQL.
 *
 * These need a real database for the reason `test-database.ts` gives: the thing
 * under test is not our arithmetic but the *database's* behaviour. The customer
 * path deletes rows by a `jsonb` path comparison — `payload -> 'body' ->
 * 'customer' -> 'id'` — and a mocked `deleteMany` recording the argument it was
 * handed proves only that the object was spelled the way the test spells it. If
 * Prisma renders that filter into SQL that matches nothing, the unit test still
 * passes and the customer's id stays in the queue.
 *
 * The other half is the row that must *not* be deleted: the redaction job
 * itself. The worker marks it SUCCEEDED after the handler returns, so a handler
 * that erases its own row leaves a redaction that did the work and then reports
 * as failed.
 */

const SHOP = testShop('redact');
const OTHER_SHOP = testShop('redact-other');

const CUSTOMER = 191167;
const OTHER_CUSTOMER = 55501;

const handler = JOB_HANDLERS['compliance.request'];

describe.skipIf(!hasDatabase)('the redaction handlers', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createTestPrisma();
  });

  afterEach(async () => {
    await cleanTestData(prisma, SHOP);
    await cleanTestData(prisma, OTHER_SHOP);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** A compliance job as the webhook router would have stored it. */
  async function complianceJob(
    shop: string,
    topic: string,
    customerId: number,
  ): Promise<string> {
    return enqueue(prisma, {
      shop,
      kind: 'compliance.request',
      payload: { topic, body: { customer: { id: customerId } } },
      correlationId: `delivery-${topic}-${String(customerId)}`,
    });
  }

  function contextFor(job: QueueJob): HandlerContext {
    return {
      job,
      prisma,
      graphqlFor: () => {
        throw new Error('A redaction handler must make no Admin API call.');
      },
      log: logger,
    };
  }

  async function idsFor(shop: string): Promise<string[]> {
    const rows = await prisma.job.findMany({
      where: { shop },
      select: { id: true },
    });
    return rows.map((row) => row.id).sort();
  }

  it('deletes the queued jobs naming the customer and nothing else', async () => {
    const theirs = await complianceJob(SHOP, 'customers/data_request', CUSTOMER);
    const someoneElses = await complianceJob(
      SHOP,
      'customers/data_request',
      OTHER_CUSTOMER,
    );
    // Same customer id, different shop. One deployment serves many stores, and
    // a delete written without the shop filter is a cross-tenant deletion.
    const otherShops = await complianceJob(
      OTHER_SHOP,
      'customers/data_request',
      CUSTOMER,
    );
    const unrelated = await enqueue(prisma, {
      shop: SHOP,
      kind: 'order.received',
      payload: { topic: 'orders/create', body: { name: '#1001' } },
      correlationId: 'delivery-order',
    });

    const request = await complianceJob(SHOP, 'customers/redact', CUSTOMER);

    await handler(
      contextFor({
        id: request,
        shop: SHOP,
        kind: 'compliance.request',
        payload: {
          topic: 'customers/redact',
          body: { customer: { id: CUSTOMER } },
        },
        attempts: 1,
        maxAttempts: 5,
        correlationId: 'delivery-redact',
        webhookId: 'delivery-redact',
        lockedBy: 'worker-test',
      }),
    );

    // `unrelated` stays: an order job holds no customer data to redact, since
    // the router projected the delivery down to an order name and a bundle id
    // before storing it.
    expect(await idsFor(SHOP)).toEqual([someoneElses, unrelated, request].sort());
    expect(await idsFor(SHOP)).not.toContain(theirs);
    expect(await idsFor(OTHER_SHOP)).toEqual([otherShops]);
  });

  it('empties the queue for the shop on shop/redact, except its own row', async () => {
    await complianceJob(SHOP, 'customers/data_request', CUSTOMER);
    await enqueue(prisma, {
      shop: SHOP,
      kind: 'catalog.export',
      payload: {},
      correlationId: 'delivery-export',
    });
    const otherShops = await enqueue(prisma, {
      shop: OTHER_SHOP,
      kind: 'order.received',
      payload: { topic: 'orders/create', body: { name: '#2002' } },
      correlationId: 'delivery-other',
    });

    const request = await enqueue(prisma, {
      shop: SHOP,
      kind: 'compliance.request',
      payload: { topic: 'shop/redact', body: {} },
      correlationId: 'delivery-shop-redact',
    });

    await handler(
      contextFor({
        id: request,
        shop: SHOP,
        kind: 'compliance.request',
        payload: { topic: 'shop/redact', body: {} },
        attempts: 1,
        maxAttempts: 5,
        correlationId: 'delivery-shop-redact',
        webhookId: 'delivery-shop-redact',
        lockedBy: 'worker-test',
      }),
    );

    expect(await idsFor(SHOP)).toEqual([request]);
    expect(await idsFor(OTHER_SHOP)).toEqual([otherShops]);
  });
});
