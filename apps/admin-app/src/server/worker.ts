import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import type { JobKind } from '@nordlys/shared';

import type { AdminGraphql } from './admin-graphql';
import {
  JOB_HANDLERS,
  PermanentJobError,
  RetryLaterError,
  type JobHandler,
} from './job-handlers';
import type { Logger } from './logger';
import {
  claimJobs,
  completeJob,
  failJob,
  reapStaleJobs,
  rescheduleJob,
  type QueueJob,
} from './queue';

/**
 * The worker.
 *
 * It runs inside the app process (ADR-0008): one deployment, one thing to
 * start, and the queue table is the same table the request handlers already
 * write to. The cost is that a slow job competes for the event loop with
 * requests, which is why the batch size is small and why extracting the worker
 * is on the v2 roadmap rather than pretended away.
 *
 * Polling, not `LISTEN`/`NOTIFY`. A notification only fires while a listener is
 * connected, so a worker that was restarting when a job was enqueued would
 * never hear about it and the poll would have to exist anyway as the safety
 * net; having both is two mechanisms to keep correct for a queue measured in
 * jobs per minute. The interval is the latency floor, and a second or two of
 * latency on a background sync is not a cost anyone can perceive.
 *
 * Several workers may run against the same table — that is what `SKIP LOCKED`
 * in `claimJobs` is for — so nothing here assumes it is alone.
 */

export interface WorkerOptions {
  prisma: PrismaClient;
  graphqlFor: (shop: string) => Promise<AdminGraphql>;
  log: Logger;
  /** How long to wait after an idle tick. */
  pollIntervalMs?: number;
  /** How many jobs one tick may claim. */
  batchSize?: number;
  /** How long a claim may be held before the reaper releases it. */
  staleLockMs?: number;
  /** Injected for tests; the real one is `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * What to run for each kind. Defaults to every handler this deploy ships.
   *
   * Overridable so the loop can be tested for what *it* does with a handler's
   * outcome — succeeded, failed, waiting — without standing up the work the
   * real handler would do to get there.
   */
  handlers?: Record<JobKind, JobHandler>;
}

export interface Worker {
  /** Run one tick: reap, claim, execute. Returns how many jobs it ran. */
  tick(): Promise<number>;
  /** Start the poll loop. Returns once {@link stop} has been honoured. */
  start(): Promise<void>;
  /** Ask the loop to finish its current tick and exit. */
  stop(): void;
  readonly id: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * How often the reaper runs, as a multiple of the poll interval.
 *
 * Releasing an abandoned job is not urgent — nothing is waiting on it that has
 * not already waited for the lock to go stale — and the query scans by index
 * over every RUNNING row, so it does not need to run on every tick.
 */
const REAP_EVERY_TICKS = 20;

export function createWorker(options: WorkerOptions): Worker {
  const {
    prisma,
    graphqlFor,
    log,
    pollIntervalMs = 2000,
    batchSize = 5,
    staleLockMs,
    sleep = defaultSleep,
    handlers = JOB_HANDLERS,
  } = options;

  // Identifies which process holds a claim. Useful the moment there is more
  // than one worker, and harmless before that.
  const workerId = `worker-${randomUUID()}`;

  let running = false;
  let ticksSinceReap = 0;

  async function runOne(job: QueueJob): Promise<void> {
    // The correlation id was minted when the delivery arrived and stored on the
    // row. Restoring it here is what lets one webhook be followed across the
    // HTTP response that already went back to Shopify, a queue, and — if the
    // process restarted in between — a different run of this program.
    const jobLog = log.child({
      correlationId: job.correlationId,
      shop: job.shop,
      jobId: job.id,
      jobKind: job.kind,
      attempt: job.attempts,
    });

    const handler = handlers[job.kind] as JobHandler | undefined;

    if (!handler) {
      // A kind written by a newer deploy, or by hand. Retrying cannot conjure
      // the code, so it goes straight to the dead-letter state.
      await failJob(
        prisma,
        { ...job, attempts: job.maxAttempts },
        `No handler registered for job kind "${job.kind}".`,
      );
      jobLog.error('Job has no handler; moved to the dead-letter state');
      return;
    }

    const startedAt = Date.now();

    try {
      await handler({ job, prisma, graphqlFor, log: jobLog });
      await completeJob(prisma, job.id);
      jobLog.info('Job succeeded', { durationMs: Date.now() - startedAt });
    } catch (error) {
      if (error instanceof RetryLaterError) {
        // Waiting on something outside this process, not failing. The row goes
        // back to PENDING with its attempt returned, so a slow bulk operation
        // cannot exhaust an attempt budget meant for failures — and the sync
        // log does not show a red row for work that is going fine.
        await rescheduleJob(prisma, job.id, error.runAt);
        jobLog.info('Job is waiting; rescheduled', {
          durationMs: Date.now() - startedAt,
          runAt: error.runAt.toISOString(),
          reason: error.message,
        });
        return;
      }

      const message = error instanceof Error ? error.message : String(error);

      // A permanent failure skips the remaining attempts by presenting the job
      // as already out of budget. Retrying a malformed payload four more times
      // only delays the sync log showing anyone that it is broken.
      const outcome = await failJob(
        prisma,
        error instanceof PermanentJobError
          ? { ...job, attempts: job.maxAttempts }
          : job,
        message,
      );

      jobLog[outcome === 'dead' ? 'error' : 'warn'](
        outcome === 'dead'
          ? 'Job failed and will not be retried'
          : 'Job failed; a retry is scheduled',
        { durationMs: Date.now() - startedAt, error: message },
      );
    }
  }

  async function tick(): Promise<number> {
    if (ticksSinceReap >= REAP_EVERY_TICKS) {
      ticksSinceReap = 0;
      const released = await reapStaleJobs(
        prisma,
        staleLockMs === undefined ? {} : { staleAfterMs: staleLockMs },
      );
      if (released > 0) {
        log.warn('Released jobs whose worker had gone away', { released });
      }
    }
    ticksSinceReap += 1;

    const jobs = await claimJobs(prisma, workerId, batchSize);

    // Sequentially, not with Promise.all. Jobs in one batch often touch the
    // same shop, and running them in parallel would have several of them
    // competing for the same Admin API rate-limit bucket — the thing rule 4 and
    // the throttle gate exist to avoid.
    for (const job of jobs) {
      await runOne(job);
    }

    return jobs.length;
  }

  return {
    id: workerId,
    tick,
    stop: () => {
      running = false;
    },
    async start() {
      running = true;
      log.info('Queue worker started', { workerId, pollIntervalMs, batchSize });

      while (running) {
        let processed = 0;

        try {
          processed = await tick();
        } catch (error) {
          // A failure of the queue itself — the database is down, the claim
          // statement is wrong — as opposed to a job failing, which `runOne`
          // has already handled. The loop must not exit on it: the database
          // coming back should resume work without a restart.
          log.error('Queue tick failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }

        // A tick that filled its batch probably has more waiting, so it loops
        // straight round; an empty one waits. This is what keeps a burst of
        // deliveries from being drained one batch per poll interval.
        if (processed < batchSize) {
          await sleep(pollIntervalMs);
        }
      }

      log.info('Queue worker stopped', { workerId });
    },
  };
}
