import type { PrismaClient } from '@prisma/client';
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createApiRouter } from './api-router';
import type { AdminGraphql } from './admin-graphql';
import { claimJobs, enqueue, failJob } from './queue';
import { listJobs, retryJob, JobNotRetryableError } from './sync-log';
import {
  cleanTestData,
  createTestPrisma,
  hasDatabase,
  only,
  testShop,
} from './test-database';

/**
 * The other half of this phase's completion criterion: a failure is visible and
 * can be retried by hand.
 *
 * Both halves need a real database — "visible" means the row's status and error
 * after a real failure, and "retryable" means a state transition that has to be
 * safe against two people pressing the button at once.
 */

const SHOP = testShop('synclog');
const OTHER_SHOP = testShop('synclog-other');

const noopGraphql: AdminGraphql = async () => ({ data: {} as never });

describe.skipIf(!hasDatabase)('the sync log', () => {
  let prisma: PrismaClient;
  let app: express.Express;

  beforeAll(() => {
    prisma = createTestPrisma();
    app = express();
    app.use(
      '/api',
      createApiRouter({
        prisma,
        contextFor: () => ({ shop: SHOP, graphql: noopGraphql }),
      }),
    );
  });

  afterEach(async () => {
    await cleanTestData(prisma, SHOP);
    await cleanTestData(prisma, OTHER_SHOP);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Queue a job, claim it, and fail it out of attempts. */
  async function deadJob(): Promise<string> {
    const id = await enqueue(prisma, {
      shop: SHOP,
      kind: 'inventory.push',
      payload: { topic: 'orders/create', body: {} },
      correlationId: 'delivery-1',
      maxAttempts: 1,
    });

    const claimed = only(await claimJobs(prisma, 'worker-test', 10));
    await failJob(prisma, claimed, 'The ERP refused the connection');

    return id;
  }

  it('shows the failure and the reason for it', async () => {
    await deadJob();

    const job = only(await listJobs(prisma, SHOP));

    expect(job.status).toBe('dead');
    // A merchant told a sync failed and not why has been told nothing they can
    // act on, so the reason goes all the way to the screen.
    expect(job.lastError).toBe('The ERP refused the connection');
    expect(job.attempts).toBe(1);
    expect(job.correlationId).toBe('delivery-1');
  });

  it('never shows another shop’s jobs', async () => {
    await enqueue(prisma, {
      shop: OTHER_SHOP,
      kind: 'order.received',
      payload: { topic: 'orders/create', body: { name: '#9999' } },
      correlationId: 'other-1',
    });

    // One deployment serves many stores; an unscoped query here would put one
    // merchant's order names on another merchant's screen.
    expect(await listJobs(prisma, SHOP)).toEqual([]);
  });

  it('puts a dead job back on the queue with a fresh budget', async () => {
    const id = await deadJob();

    const retried = await retryJob(prisma, SHOP, id);

    expect(retried.status).toBe('pending');
    // Reset, not preserved: a manual retry is a person saying the dependency is
    // back, and one remaining attempt would send it straight back to DEAD.
    expect(retried.attempts).toBe(0);

    // And the worker can now claim it, which is what makes the retry real
    // rather than a status change.
    const claimed = only(await claimJobs(prisma, 'worker-test', 10));
    expect(claimed.id).toBe(id);
  });

  it('lets only one of two simultaneous retries through', async () => {
    // Two admin tabs, one row. A check-then-update would let both pass and
    // produce two runs; the state is in the `where` clause instead.
    const id = await deadJob();

    const results = await Promise.allSettled([
      retryJob(prisma, SHOP, id),
      retryJob(prisma, SHOP, id),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
  });

  it('refuses to retry a job that has not failed', async () => {
    const id = await enqueue(prisma, {
      shop: SHOP,
      kind: 'order.received',
      payload: { topic: 'orders/create', body: {} },
      correlationId: 'c1',
    });

    await expect(retryJob(prisma, SHOP, id)).rejects.toBeInstanceOf(
      JobNotRetryableError,
    );
  });

  it('refuses to retry a job belonging to another shop', async () => {
    const id = await enqueue(prisma, {
      shop: OTHER_SHOP,
      kind: 'order.received',
      payload: { topic: 'orders/create', body: {} },
      correlationId: 'other-1',
    });

    // Not "forbidden" but "no such job": from this shop's side it does not
    // exist, and saying otherwise would confirm that it does.
    await expect(retryJob(prisma, SHOP, id)).rejects.toThrow(/No job/);
  });

  describe('over HTTP', () => {
    it('GET /api/jobs returns the shop’s log', async () => {
      await deadJob();

      const response = await request(app).get('/api/jobs');

      expect(response.status).toBe(200);
      expect(response.body.jobs).toHaveLength(1);
      expect(response.body.jobs[0]).toMatchObject({
        status: 'dead',
        kind: 'inventory.push',
        lastError: 'The ERP refused the connection',
      });
    });

    it('POST /api/jobs/:id/retry requeues it', async () => {
      const id = await deadJob();

      const response = await request(app).post(`/api/jobs/${id}/retry`);

      expect(response.status).toBe(200);
      expect(response.body.job).toMatchObject({ status: 'pending' });
    });

    it('answers 404 for an id that is not retryable', async () => {
      const response = await request(app).post('/api/jobs/nope/retry');

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('not_found');
    });
  });
});
