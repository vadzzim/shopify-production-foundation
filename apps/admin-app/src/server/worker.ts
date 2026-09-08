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

/**
 * This worker finished a job it no longer owned.
 *
 * Its lock went stale — the run outlasted the staleness window, or the process
 * was paused long enough for it to look that way — the reaper released the row,
 * and another worker took it. The outcome is dropped rather than written, which
 * is what stops a late write marking someone else's in-flight attempt finished.
 *
 * Worth a warning even though nothing is broken: the work was done twice, and
 * two of these in a row means the staleness window is shorter than a job of
 * this kind actually takes.
 */
function claimLost(log: Logger, startedAt: number, what: string): void {
  log.warn('Claim expired while the job was running; outcome dropped', {
    durationMs: Date.now() - startedAt,
    outcome: what,
  });
}

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
      await failJob(prisma, job, `No handler registered for job kind "${job.kind}".`, {
        permanent: true,
      });
      jobLog.error('Job has no handler; moved to the dead-letter state');
      return;
    }

    const startedAt = Date.now();

    try {
      await handler({ job, prisma, graphqlFor, log: jobLog });
      const outcome = await completeJob(prisma, job);

      if (outcome === 'claim_lost') {
        claimLost(jobLog, startedAt, 'succeeded');
        return;
      }

      jobLog.info('Job succeeded', { durationMs: Date.now() - startedAt });
    } catch (error) {
      if (error instanceof RetryLaterError) {
        // Waiting on something outside this process, not failing. The row goes
        // back to PENDING with its attempt returned, so a slow bulk operation
        // cannot exhaust an attempt budget meant for failures — and the sync
        // log does not show a red row for work that is going fine.
        const outcome = await rescheduleJob(prisma, job, error.runAt);

        if (outcome === 'claim_lost') {
          claimLost(jobLog, startedAt, 'asked to be rescheduled');
          return;
        }

        jobLog.info('Job is waiting; rescheduled', {
          durationMs: Date.now() - startedAt,
          runAt: error.runAt.toISOString(),
          reason: error.message,
        });
        return;
      }

      const message = error instanceof Error ? error.message : String(error);

      // A permanent failure skips the remaining attempts: retrying a malformed
      // payload four more times only delays the sync log showing anyone that it
      // is broken.
      const outcome = await failJob(prisma, job, message, {
        permanent: error instanceof PermanentJobError,
      });

      if (outcome === 'claim_lost') {
        claimLost(jobLog, startedAt, 'failed');
        return;
      }

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
      const reaped = await reapStaleJobs(
        prisma,
        staleLockMs === undefined ? {} : { staleAfterMs: staleLockMs },
      );
      if (reaped.released > 0 || reaped.dead > 0) {
        // Reported together and distinguished: a released job is a redeploy at
        // an awkward moment, while a dead-lettered one is a job that has now
        // taken a worker down as many times as it is allowed to, which is a
        // different thing to go and look at.
        log.warn('Reaped jobs whose worker had gone away', {
          released: reaped.released,
          dead: reaped.dead,
        });
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
