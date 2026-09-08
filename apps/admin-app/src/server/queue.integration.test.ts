import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  acceptDelivery,
  claimJobs,
  completeJob,
  enqueue,
  failJob,
  reapStaleJobs,
} from './queue';
import {
  cleanTestData,
  createTestPrisma,
  hasDatabase,
  only,
  testShop,
} from './test-database';

/**
 * The two database guarantees the queue rests on, checked against PostgreSQL.
 *
 * Everything here would pass against a mock while being wrong in production,
 * which is the whole reason this file talks to a real server. See
 * `test-database.ts` for why it skips itself when there is no `DATABASE_URL`.
 */

const SHOP = testShop('queue');

describe.skipIf(!hasDatabase)('the queue, against PostgreSQL', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createTestPrisma();
  });

  afterEach(async () => {
    await cleanTestData(prisma, SHOP);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /**
   * One job, two claims: the first worker's lock went stale and a second worker
   * now holds the row.
   *
   * Reproduced through the real sequence rather than by editing columns — claim,
   * backdate the lock, reap, claim again — so what the transitions are tested
   * against is a row PostgreSQL actually produced.
   */
  async function lostClaim(): Promise<{
    stale: Awaited<ReturnType<typeof claimJobs>>[number];
    current: Awaited<ReturnType<typeof claimJobs>>[number];
  }> {
    await enqueue(prisma, {
      shop: SHOP,
      kind: 'catalog.export',
      payload: {},
      correlationId: 'c1',
    });

    const stale = only(await claimJobs(prisma, 'worker-slow', 1));

    await prisma.job.update({
      where: { id: stale.id },
      data: { lockedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    await reapStaleJobs(prisma);

    const current = only(await claimJobs(prisma, 'worker-fresh', 1));

    expect(current.id).toBe(stale.id);
    expect(current.attempts).toBe(stale.attempts + 1);

    return { stale, current };
  }

  describe('acceptDelivery', () => {
    const delivery = {
      webhookId: 'delivery-1',
      shop: SHOP,
      topic: 'orders/create',
      apiVersion: '2026-07',
      jobs: [
        {
          shop: SHOP,
          kind: 'order.received' as const,
          payload: { topic: 'orders/create', body: { id: 1 } },
          correlationId: 'delivery-1',
        },
      ],
    };

    it('enqueues once for the first delivery', async () => {
      const result = await acceptDelivery(prisma, delivery);

      expect(result.accepted).toBe(true);
      expect(result.jobIds).toHaveLength(1);
      expect(await prisma.job.count({ where: { shop: SHOP } })).toBe(1);
    });

    it('enqueues nothing the second time the same delivery arrives', async () => {
      await acceptDelivery(prisma, delivery);
      const second = await acceptDelivery(prisma, delivery);

      expect(second).toEqual({ accepted: false, jobIds: [] });
      // The point of the phase, in one assertion: a redelivery leaves one job.
      expect(await prisma.job.count({ where: { shop: SHOP } })).toBe(1);
    });

    it('enqueues once when both deliveries arrive at the same moment', async () => {
      // The case a `SELECT` before the `INSERT` gets wrong and a unique index
      // does not: two connections, neither able to see the other's uncommitted
      // row, both deciding the delivery is new.
      const results = await Promise.all([
        acceptDelivery(prisma, delivery),
        acceptDelivery(prisma, delivery),
        acceptDelivery(prisma, delivery),
      ]);

      expect(results.filter((result) => result.accepted)).toHaveLength(1);
      expect(await prisma.job.count({ where: { shop: SHOP } })).toBe(1);
    });

    it('records the delivery even when it produces no job', async () => {
      const result = await acceptDelivery(prisma, {
        ...delivery,
        webhookId: 'delivery-no-job',
        jobs: [],
      });

      expect(result.accepted).toBe(true);
      expect(
        await prisma.webhookDelivery.count({
          where: { id: 'delivery-no-job' },
        }),
      ).toBe(1);
      expect(await prisma.job.count({ where: { shop: SHOP } })).toBe(0);
    });

    it('writes the delivery and the job in one transaction', async () => {
      // A job kind is a plain string in the database, but `payload` is `jsonb`
      // and rejects `undefined`. Forcing the insert to fail proves the delivery
      // row is not left behind on its own — which is what would make the event
      // permanently invisible: Shopify would not resend it, and nothing here
      // would have work queued for it.
      await expect(
        acceptDelivery(prisma, {
          ...delivery,
          webhookId: 'delivery-rollback',
          jobs: [
            {
              shop: SHOP,
              kind: 'order.received',
              payload: { ok: true },
              // A correlation id is NOT NULL in the schema.
              correlationId: undefined as unknown as string,
            },
          ],
        }),
      ).rejects.toThrow();

      expect(
        await prisma.webhookDelivery.count({
          where: { id: 'delivery-rollback' },
        }),
      ).toBe(0);
    });
  });

  describe('claimJobs', () => {
    it('hands a job to exactly one of two concurrent workers', async () => {
      await enqueue(prisma, {
        shop: SHOP,
        kind: 'order.received',
        payload: { topic: 'orders/create', body: {} },
        correlationId: 'c1',
      });

      // Without SKIP LOCKED the second claim would block on the first's row
      // lock and then return the same row once it was released.
      const [first, second] = await Promise.all([
        claimJobs(prisma, 'worker-a', 5),
        claimJobs(prisma, 'worker-b', 5),
      ]);

      expect(first.length + second.length).toBe(1);
    });

    it('splits a batch between workers rather than blocking one of them', async () => {
      for (let i = 0; i < 6; i += 1) {
        await enqueue(prisma, {
          shop: SHOP,
          kind: 'order.received',
          payload: { topic: 'orders/create', body: { i } },
          correlationId: `c${String(i)}`,
        });
      }

      const [first, second] = await Promise.all([
        claimJobs(prisma, 'worker-a', 3),
        claimJobs(prisma, 'worker-b', 3),
      ]);

      expect(first.length + second.length).toBe(6);
      const ids = [...first, ...second].map((job) => job.id);
      expect(new Set(ids).size).toBe(6);
    });

    it('counts the attempt at claim time, not at failure time', async () => {
      // A worker killed mid-job never runs its failure path. If attempts were
      // counted there, such a job would be retried forever.
      await enqueue(prisma, {
        shop: SHOP,
        kind: 'order.received',
        payload: { topic: 'orders/create', body: {} },
        correlationId: 'c1',
      });

      const claimed = only(await claimJobs(prisma, 'worker-a', 1));

      expect(claimed.attempts).toBe(1);
      expect(
        (await prisma.job.findFirstOrThrow({ where: { id: claimed.id } }))
          .status,
      ).toBe('RUNNING');
    });

    it('leaves a job alone until its runAt has passed', async () => {
      await enqueue(prisma, {
        shop: SHOP,
        kind: 'order.received',
        payload: { topic: 'orders/create', body: {} },
        correlationId: 'c1',
        runAt: new Date(Date.now() + 60_000),
      });

      expect(await claimJobs(prisma, 'worker-a', 5)).toEqual([]);
    });

    it('picks a failed job back up once its backoff has elapsed', async () => {
      const id = await enqueue(prisma, {
        shop: SHOP,
        kind: 'order.received',
        payload: { topic: 'orders/create', body: {} },
        correlationId: 'c1',
      });

      const claimed = only(await claimJobs(prisma, 'worker-a', 1));
      await failJob(prisma, claimed, 'the ERP was down', {
        // Retry immediately, so the test does not have to wait out a backoff.
        baseMs: 0,
        random: () => 0,
      });

      const again = only(await claimJobs(prisma, 'worker-a', 1));

      expect(again.id).toBe(id);
      expect(again.attempts).toBe(2);
    });

    it('never claims a job whose attempts are already spent', async () => {
      // The invariant, enforced where the work is handed out rather than only
      // where a failure is recorded: a FAILED row that is out of budget is not
      // runnable, however it came to be FAILED. `failJob` would have made such
      // a row DEAD, so what this guards against is every other route to it — a
      // reaper release, a row edited by hand, a `maxAttempts` lowered later.
      const id = await enqueue(prisma, {
        shop: SHOP,
        kind: 'order.received',
        payload: { topic: 'orders/create', body: {} },
        correlationId: 'c1',
      });

      await prisma.job.update({
        where: { id },
        data: { status: 'FAILED', attempts: 5, maxAttempts: 5 },
      });

      expect(await claimJobs(prisma, 'worker-a', 1)).toEqual([]);
    });
  });

  describe('failJob', () => {
    it('moves a job to the dead-letter state once attempts run out', async () => {
      await enqueue(prisma, {
        shop: SHOP,
        kind: 'order.received',
        payload: { topic: 'orders/create', body: {} },
        correlationId: 'c1',
        maxAttempts: 1,
      });

      const claimed = only(await claimJobs(prisma, 'worker-a', 1));
      const outcome = await failJob(prisma, claimed, 'Shopify answered 500');

      expect(outcome).toBe('dead');

      const row = await prisma.job.findFirstOrThrow({
        where: { id: claimed.id },
      });
      expect(row.status).toBe('DEAD');
      expect(row.lastError).toBe('Shopify answered 500');
      expect(row.finishedAt).not.toBeNull();

      // And a dead job is not picked up again.
      expect(await claimJobs(prisma, 'worker-a', 5)).toEqual([]);
    });

    it('skips the remaining attempts when the failure is permanent', async () => {
      // The caller used to say this by passing a falsified attempt count. It
      // now says it in words, because the write is conditioned on that count
      // matching the row.
      await enqueue(prisma, {
        shop: SHOP,
        kind: 'order.received',
        payload: { topic: 'orders/create', body: {} },
        correlationId: 'c1',
        maxAttempts: 5,
      });

      const claimed = only(await claimJobs(prisma, 'worker-a', 1));
      const outcome = await failJob(prisma, claimed, 'payload is nonsense', {
        permanent: true,
      });

      expect(outcome).toBe('dead');
      expect(
        (await prisma.job.findFirstOrThrow({ where: { id: claimed.id } }))
          .status,
      ).toBe('DEAD');
    });

    it('does not record a failure against an attempt it no longer owns', async () => {
      const { stale, current } = await lostClaim();

      expect(await failJob(prisma, stale, 'the ERP refused')).toBe(
        'claim_lost',
      );

      // Still the second worker's, still running, and with no error written
      // against an attempt that has not finished.
      const row = await prisma.job.findFirstOrThrow({ where: { id: stale.id } });
      expect(row.status).toBe('RUNNING');
      expect(row.lockedBy).toBe(current.lockedBy);
      // The reaper's note is still there — nothing has overwritten it with a
      // failure belonging to an attempt that has not finished.
      expect(row.lastError).not.toBe('the ERP refused');
    });
  });

  describe('completeJob', () => {
    it('clears the lock and the last error', async () => {
      await enqueue(prisma, {
        shop: SHOP,
        kind: 'order.received',
        payload: { topic: 'orders/create', body: {} },
        correlationId: 'c1',
      });

      const claimed = only(await claimJobs(prisma, 'worker-a', 1));
      await completeJob(prisma, claimed);

      const row = await prisma.job.findFirstOrThrow({
        where: { id: claimed.id },
      });
      expect(row.status).toBe('SUCCEEDED');
      expect(row.lockedBy).toBeNull();
      expect(row.finishedAt).not.toBeNull();
    });

    it('does not mark another worker’s attempt succeeded', async () => {
      // The race this guards: a worker whose lock went stale — a slow Admin API
      // call, an export download — is still running and still believes the job
      // is its own. Writing by id alone, it would mark the *second* worker's
      // in-flight attempt SUCCEEDED and clear its lock, freeing the row for a
      // third claim while the second attempt is still going.
      const { stale, current } = await lostClaim();

      expect(await completeJob(prisma, stale)).toBe('claim_lost');

      const row = await prisma.job.findFirstOrThrow({ where: { id: stale.id } });
      expect(row.status).toBe('RUNNING');
      expect(row.lockedBy).toBe(current.lockedBy);
      expect(row.finishedAt).toBeNull();
    });

    it('applies to the worker that does still hold the claim', async () => {
      // The other side of the same test: the guard must not reject the write it
      // exists to protect.
      const { current } = await lostClaim();

      expect(await completeJob(prisma, current)).toBe('applied');
      expect(
        (await prisma.job.findFirstOrThrow({ where: { id: current.id } }))
          .status,
      ).toBe('SUCCEEDED');
    });
  });

  describe('reapStaleJobs', () => {
    it('releases a job whose worker never came back', async () => {
      await enqueue(prisma, {
        shop: SHOP,
        kind: 'order.received',
        payload: { topic: 'orders/create', body: {} },
        correlationId: 'c1',
      });

      const claimed = only(await claimJobs(prisma, 'worker-a', 1));

      // Backdate the lock rather than shorten the staleness window. `lockedAt`
      // is written by PostgreSQL's `now()` while the cutoff is computed in this
      // process, so a zero window makes the test a race against the clock skew
      // between the container and the host — which is how it first failed. This
      // way the reaper runs on the same real clock it uses in production.
      await prisma.job.update({
        where: { id: claimed.id },
        data: { lockedAt: new Date(Date.now() - 60 * 60 * 1000) },
      });

      // Nothing else in the design would ever look at this row again: claiming
      // only considers PENDING and FAILED.
      expect(await reapStaleJobs(prisma)).toEqual({ released: 1, dead: 0 });

      const again = only(await claimJobs(prisma, 'worker-b', 1));
      expect(again.id).toBe(claimed.id);
      // The attempt the dead worker spent still counts, so a job that reliably
      // kills its worker ends up dead rather than cycling.
      expect(again.attempts).toBe(2);
    });

    it('dead-letters a stale job that has no attempts left', async () => {
      // The case the reaper is the only place that can catch. A job that takes
      // its worker down with it never runs `failJob`, so nothing else ever
      // compares it against its budget: released unconditionally, it would be
      // claimed, kill another worker, be released again, and keep the sync log
      // showing FAILED forever.
      await enqueue(prisma, {
        shop: SHOP,
        kind: 'order.received',
        payload: { topic: 'orders/create', body: {} },
        correlationId: 'c1',
        maxAttempts: 1,
      });

      const claimed = only(await claimJobs(prisma, 'worker-a', 1));
      expect(claimed.attempts).toBe(claimed.maxAttempts);

      await prisma.job.update({
        where: { id: claimed.id },
        data: { lockedAt: new Date(Date.now() - 60 * 60 * 1000) },
      });

      expect(await reapStaleJobs(prisma)).toEqual({ released: 0, dead: 1 });

      const row = await prisma.job.findFirstOrThrow({
        where: { id: claimed.id },
      });
      expect(row.status).toBe('DEAD');
      expect(row.finishedAt).not.toBeNull();
      expect(row.lastError).toContain('out of attempts');

      expect(await claimJobs(prisma, 'worker-b', 1)).toEqual([]);
    });

    it('leaves a freshly claimed job alone', async () => {
      await enqueue(prisma, {
        shop: SHOP,
        kind: 'order.received',
        payload: { topic: 'orders/create', body: {} },
        correlationId: 'c1',
      });

      await claimJobs(prisma, 'worker-a', 1);

      expect(await reapStaleJobs(prisma, { staleAfterMs: 60_000 })).toEqual({
        released: 0,
        dead: 0,
      });
    });
  });
});
