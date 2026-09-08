import type { Prisma, PrismaClient } from '@prisma/client';
import type { JobKind, JobStatus } from '@nordlys/shared';

/**
 * The queue: a table in the same PostgreSQL database as everything else
 * (ADR-0007, decision 3).
 *
 * Two properties are worth stating up front, because they are the reason a
 * table beats a broker at this size.
 *
 * **Accepting a webhook and enqueueing its work is one transaction.** The
 * delivery row and the job row are written together or not at all. With Redis
 * holding the queue, "recorded as delivered" and "queued for work" live in two
 * systems, and a crash between them either drops the work or duplicates it.
 *
 * **Claiming is `SELECT ... FOR UPDATE SKIP LOCKED`.** Several workers can poll
 * the same table concurrently and never hand the same row to two of them, with
 * no lock server and no leader election. That is the primitive the whole design
 * rests on, and it is also the one thing Prisma's query API cannot express —
 * see {@link claimJobs}.
 */

/** How long a job may be held before the reaper assumes its worker died. */
const DEFAULT_STALE_LOCK_MS = 5 * 60 * 1000;

/** First retry delay. Doubles per attempt, then gets jitter. */
const DEFAULT_BACKOFF_BASE_MS = 10_000;

/** Ceiling on a single backoff delay, so attempt five is not next Tuesday. */
const DEFAULT_BACKOFF_MAX_MS = 15 * 60 * 1000;

export interface QueueJob {
  id: string;
  shop: string;
  kind: JobKind;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  correlationId: string;
  webhookId: string | null;
}

export interface EnqueueInput {
  shop: string;
  kind: JobKind;
  payload: Prisma.InputJsonValue;
  correlationId: string;
  webhookId?: string;
  maxAttempts?: number;
  /** Delay the first run. Used by retries, not by webhook receipt. */
  runAt?: Date;
}

export interface AcceptDeliveryInput {
  webhookId: string;
  eventId?: string;
  shop: string;
  topic: string;
  apiVersion: string;
  /** The jobs this delivery should produce. Usually one; may be none. */
  jobs: readonly Omit<EnqueueInput, 'webhookId'>[];
}

export type AcceptDeliveryResult =
  | { accepted: true; jobIds: string[] }
  /** The same delivery id has already been recorded. Nothing was enqueued. */
  | { accepted: false; jobIds: [] };

/**
 * Record a delivery and enqueue its work, exactly once, in one transaction.
 *
 * Rule 10: the idempotency is the primary key on `WebhookDelivery` plus
 * `ON CONFLICT DO NOTHING`, not a `SELECT` that asks whether the row is there.
 * The difference is not stylistic. Shopify retries on a slow response, and a
 * retry commonly overlaps the original — two requests, two pooled connections,
 * both running `findUnique` before either has committed, both finding nothing,
 * both enqueueing. The unique index makes the second insert a no-op decided by
 * PostgreSQL under the row lock it already holds.
 *
 * `createMany({ skipDuplicates: true })` is the Prisma spelling of that. It was
 * verified rather than assumed: against PostgreSQL 16 with Prisma 6.19.3 it
 * emits
 *
 *     INSERT INTO "public"."WebhookDelivery" (...) VALUES (...)
 *       ON CONFLICT DO NOTHING
 *
 * and returns `count: 0` for a duplicate — which is the signal this function
 * reads. (`skipDuplicates` is unavailable on some providers, so the check is
 * worth repeating if the datasource ever changes.)
 */
export async function acceptDelivery(
  prisma: PrismaClient,
  input: AcceptDeliveryInput,
): Promise<AcceptDeliveryResult> {
  return prisma.$transaction(async (tx) => {
    const inserted = await tx.webhookDelivery.createMany({
      data: [
        {
          id: input.webhookId,
          ...(input.eventId ? { eventId: input.eventId } : {}),
          shop: input.shop,
          topic: input.topic,
          apiVersion: input.apiVersion,
        },
      ],
      skipDuplicates: true,
    });

    if (inserted.count === 0) {
      return { accepted: false, jobIds: [] };
    }

    const jobIds: string[] = [];

    for (const job of input.jobs) {
      const created = await tx.job.create({
        data: {
          shop: job.shop,
          kind: job.kind,
          payload: job.payload,
          correlationId: job.correlationId,
          webhookId: input.webhookId,
          ...(job.maxAttempts === undefined
            ? {}
            : { maxAttempts: job.maxAttempts }),
          ...(job.runAt === undefined ? {} : { runAt: job.runAt }),
        },
        select: { id: true },
      });

      jobIds.push(created.id);
    }

    return { accepted: true, jobIds };
  });
}

/** Enqueue a job with no delivery behind it: a retry, or a UI action. */
export async function enqueue(
  prisma: PrismaClient,
  input: EnqueueInput,
): Promise<string> {
  const created = await prisma.job.create({
    data: {
      shop: input.shop,
      kind: input.kind,
      payload: input.payload,
      correlationId: input.correlationId,
      ...(input.webhookId === undefined ? {} : { webhookId: input.webhookId }),
      ...(input.maxAttempts === undefined
        ? {}
        : { maxAttempts: input.maxAttempts }),
      ...(input.runAt === undefined ? {} : { runAt: input.runAt }),
    },
    select: { id: true },
  });

  return created.id;
}

/** The columns {@link claimJobs} selects, as PostgreSQL returns them. */
interface ClaimedRow {
  id: string;
  shop: string;
  kind: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  correlationId: string;
  webhookId: string | null;
}

/**
 * Take up to `limit` runnable jobs and mark them as this worker's.
 *
 * ## Why this is raw SQL (rule 9)
 *
 * **Prisma's query API cannot express `SKIP LOCKED`.** There is no option for
 * it on `findMany`, and no way to attach a locking clause to a Prisma query at
 * all — the feature request has been open since 2019. So this call site uses
 * `$queryRaw`, and rule 9 requires the reason to be written here rather than
 * left for a reviewer to guess.
 *
 * `SKIP LOCKED` is not a nicety. Without it, a second worker polling the same
 * table *blocks* on the rows the first worker has locked instead of moving past
 * them, and the queue processes serially however many workers are running. With
 * it, each worker takes rows nobody else holds and returns immediately.
 *
 * The statement is one `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP
 * LOCKED)` rather than a select followed by an update. A single statement is
 * atomic on its own, so the locks the subquery takes are held until the update
 * commits, and no transaction wrapper is needed to keep another worker out of
 * the gap between the two.
 *
 * `attempts` is incremented **on claim**, not on failure. A worker killed
 * mid-job — an OOM, a redeploy — never runs its failure path, and a counter
 * incremented there would let such a job be retried forever. Counting attempts
 * at claim time means every claim costs one, which is the property the attempt
 * limit actually needs.
 */
export async function claimJobs(
  prisma: PrismaClient,
  workerId: string,
  limit: number,
): Promise<QueueJob[]> {
  const rows = await prisma.$queryRaw<ClaimedRow[]>`
    UPDATE "Job" AS j
       SET status = 'RUNNING'::"JobStatus",
           "lockedAt" = now(),
           "lockedBy" = ${workerId},
           attempts = j.attempts + 1,
           "updatedAt" = now()
     WHERE j.id IN (
       SELECT c.id
         FROM "Job" AS c
        WHERE c.status IN ('PENDING'::"JobStatus", 'FAILED'::"JobStatus")
          AND c."runAt" <= now()
        ORDER BY c."runAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING j.id,
              j.shop,
              j.kind,
              j.payload,
              j.attempts,
              j."maxAttempts",
              j."correlationId",
              j."webhookId"
  `;

  return rows.map((row) => ({
    id: row.id,
    shop: row.shop,
    kind: row.kind as JobKind,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    correlationId: row.correlationId,
    webhookId: row.webhookId,
  }));
}

export async function completeJob(
  prisma: PrismaClient,
  jobId: string,
): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: 'SUCCEEDED',
      finishedAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
    },
  });
}

/**
 * Put a job back on the queue **without** counting the claim as an attempt.
 *
 * This is not a failure path. It exists for work that is waiting on something
 * outside this process — today the catalog export, which polls a bulk operation
 * Shopify runs on its own schedule. Recording that as a failure would put a job
 * that is progressing normally in front of the merchant with a red badge and an
 * error message invented to fill `lastError`.
 *
 * The attempt is given back deliberately. `claimJobs` counts attempts on claim,
 * because a worker killed mid-job never runs its failure path — but a poll that
 * found "still running" *did* run its path, and it is not one of the failures
 * the attempt budget is there to bound. Without the decrement a slow export
 * would exhaust its budget by succeeding at waiting.
 */
export async function rescheduleJob(
  prisma: PrismaClient,
  jobId: string,
  runAt: Date,
): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: 'PENDING',
      runAt,
      lockedAt: null,
      lockedBy: null,
      attempts: { decrement: 1 },
    },
  });
}

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Injected for tests; the real one is `Math.random`. */
  random?: () => number;
}

/**
 * When a job that has failed `attempts` times should next run.
 *
 * Exponential, then jittered. The exponent spaces retries out so a dependency
 * that is down for a minute is not hit sixty times during it; the jitter is
 * there because without it a burst of jobs that failed together retries
 * together, re-creating the load that knocked the dependency over. Same
 * argument as the throttle gate in `throttle.ts`, one layer up.
 *
 * Jitter is added, not subtracted: a retry earlier than the backoff says would
 * defeat the point of computing one.
 */
export function backoffMs(
  attempts: number,
  options: BackoffOptions = {},
): number {
  const base = options.baseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const max = options.maxMs ?? DEFAULT_BACKOFF_MAX_MS;
  const random = options.random ?? Math.random;

  const exponential = Math.min(base * 2 ** Math.max(0, attempts - 1), max);

  return Math.round(exponential * (1 + random() * 0.5));
}

export interface FailJobOptions extends BackoffOptions {
  now?: () => Date;
}

export type FailOutcome = 'retry_scheduled' | 'dead';

/**
 * Record a failure: schedule a retry, or move the job to the dead-letter state.
 *
 * DEAD is a status rather than a separate table (ADR-0007). A second table
 * would need the same columns, the same indexes and a copy step that can itself
 * fail halfway; a status transition cannot come apart, and it keeps a job's
 * whole history at one id — which is what the sync log shows and what a manual
 * retry acts on.
 */
export async function failJob(
  prisma: PrismaClient,
  job: Pick<QueueJob, 'id' | 'attempts' | 'maxAttempts'>,
  error: string,
  options: FailJobOptions = {},
): Promise<FailOutcome> {
  const now = (options.now ?? (() => new Date()))();
  const exhausted = job.attempts >= job.maxAttempts;

  await prisma.job.update({
    where: { id: job.id },
    data: {
      status: exhausted ? 'DEAD' : 'FAILED',
      // Truncated: `lastError` is rendered in the sync log and can be a
      // multi-kilobyte GraphQL error body. The full text is in the logs, found
      // by correlation id.
      lastError: error.slice(0, 2000),
      lockedAt: null,
      lockedBy: null,
      ...(exhausted
        ? { finishedAt: now }
        : {
            runAt: new Date(now.getTime() + backoffMs(job.attempts, options)),
          }),
    },
  });

  return exhausted ? 'dead' : 'retry_scheduled';
}

/**
 * Put jobs whose worker disappeared back on the queue.
 *
 * A process killed while holding a job leaves the row RUNNING with nobody
 * running it, and nothing else in this design would ever look at it again —
 * `claimJobs` only considers PENDING and FAILED. The reaper is what makes the
 * queue survive a redeploy at the wrong moment.
 *
 * Released rows keep their incremented `attempts`, so a job that reliably kills
 * its worker exhausts its budget and lands in the dead-letter state instead of
 * cycling forever.
 *
 * @returns how many rows were released.
 */
export async function reapStaleJobs(
  prisma: PrismaClient,
  options: { staleAfterMs?: number; now?: () => Date } = {},
): Promise<number> {
  const staleAfter = options.staleAfterMs ?? DEFAULT_STALE_LOCK_MS;
  const now = (options.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - staleAfter);

  const released = await prisma.job.updateMany({
    where: { status: 'RUNNING', lockedAt: { lt: cutoff } },
    data: {
      status: 'FAILED',
      lockedAt: null,
      lockedBy: null,
      lastError: `Worker lock expired after ${String(staleAfter)}ms; released for retry.`,
      runAt: now,
    },
  });

  return released.count;
}

/** Prisma's `JobStatus` enum ↔ the lower-case one the API and UI speak. */
const STATUS_TO_API: Record<string, JobStatus> = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  DEAD: 'dead',
};

export function toApiStatus(status: string): JobStatus {
  const mapped = STATUS_TO_API[status];
  if (!mapped) throw new Error(`Unknown job status from the database: ${status}`);
  return mapped;
}
