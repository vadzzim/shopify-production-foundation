import type { PrismaClient } from '@prisma/client';
import {
  jobKindSchema,
  webhookTopicSchema,
  type JobSummary,
} from '@nordlys/shared';

import { logger as defaultLogger, type Logger } from './logger';
import { toApiStatus } from './queue';

/**
 * The sync log: the queue, read by a human.
 *
 * The completion criterion for this phase is "an external system failure is
 * visible in the UI and can be retried manually", and both halves are this
 * module. Visible means the failed row and *the reason* — a merchant who is
 * told a sync failed and not why has been told nothing they can act on, so
 * `lastError` goes all the way to the screen.
 *
 * Retryable means a dead job can be put back on the queue by hand, because the
 * automatic retries have a budget and the thing that broke usually outlives it.
 * Nothing here re-runs the job itself; it resets the row and lets the worker
 * pick it up, so a manual retry takes exactly the same path as an automatic one
 * and cannot behave differently from it.
 */

/** Rows a shop's sync log shows at once. */
const PAGE_SIZE = 50;

interface JobRow {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  runAt: Date;
  createdAt: Date;
  finishedAt: Date | null;
  lastError: string | null;
  correlationId: string;
  payload: unknown;
}

/**
 * The topic a job came from, for the log's first column.
 *
 * It is read out of the payload rather than stored in its own column: the
 * payload already carries it for every webhook-produced job, and a column would
 * be a second copy to keep in step. Jobs with no webhook behind them — a
 * manually pushed inventory level — have no topic, and the schema says so with
 * `null` rather than with an empty string.
 */
function topicOf(payload: unknown): JobSummary['topic'] {
  if (typeof payload !== 'object' || payload === null) return null;
  const parsed = webhookTopicSchema.safeParse(
    (payload as { topic?: unknown }).topic,
  );
  return parsed.success ? parsed.data : null;
}

function toSummary(row: JobRow): JobSummary {
  const kind = jobKindSchema.safeParse(row.kind);

  if (!kind.success) {
    // A kind this deploy does not know. Failing the whole list because of one
    // unfamiliar row would hide every row next to it, which is the opposite of
    // what a log is for — but returning it untyped would break the shared
    // schema the browser validates against. So it is loud and specific.
    throw new Error(`Job ${row.id} has an unknown kind "${row.kind}".`);
  }

  return {
    id: row.id,
    kind: kind.data,
    status: toApiStatus(row.status),
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    runAt: row.runAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    lastError: row.lastError,
    correlationId: row.correlationId,
    topic: topicOf(row.payload),
  };
}

export async function listJobs(
  prisma: PrismaClient,
  shop: string,
): Promise<JobSummary[]> {
  const rows = await prisma.job.findMany({
    // Scoped to the shop, always. One deployment serves many stores and an
    // unscoped query here would put one merchant's sync failures — order names
    // included — on another's screen.
    where: { shop },
    orderBy: { createdAt: 'desc' },
    take: PAGE_SIZE,
    select: {
      id: true,
      kind: true,
      status: true,
      attempts: true,
      maxAttempts: true,
      runAt: true,
      createdAt: true,
      finishedAt: true,
      lastError: true,
      correlationId: true,
      payload: true,
    },
  });

  return rows.map(toSummary);
}

export class JobNotRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobNotRetryableError';
  }
}

/**
 * Put a failed job back on the queue.
 *
 * The attempt counter is reset, which is the point: the job exhausted its
 * budget against a dependency that was down, and a manual retry is a person
 * saying that dependency is back. Keeping the counter would mean the retry got
 * one attempt and returned to the dead-letter state on the next hiccup.
 *
 * The update is conditional on the row still being FAILED or DEAD, expressed in
 * the `where` clause rather than checked first. Two admin tabs pressing Retry
 * on the same row, or a retry racing the worker's own scheduled attempt, would
 * otherwise both pass a check and produce two runs. `updateMany` returning zero
 * is how this function learns it lost that race, and it reports it instead of
 * claiming a retry that did not happen — the same reasoning as rule 10, applied
 * to a state transition rather than to an insert.
 */
export async function retryJob(
  prisma: PrismaClient,
  shop: string,
  jobId: string,
  options: { logger?: Logger } = {},
): Promise<JobSummary> {
  const log = options.logger ?? defaultLogger;

  const updated = await prisma.job.updateMany({
    where: { id: jobId, shop, status: { in: ['FAILED', 'DEAD'] } },
    data: {
      status: 'PENDING',
      attempts: 0,
      runAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      finishedAt: null,
    },
  });

  if (updated.count === 0) {
    const exists = await prisma.job.findFirst({
      where: { id: jobId, shop },
      select: { status: true },
    });

    if (!exists) {
      throw new JobNotRetryableError(`No job ${jobId} in this shop's log.`);
    }

    throw new JobNotRetryableError(
      `Job ${jobId} is ${toApiStatus(exists.status)}; only a failed or dead job can be retried.`,
    );
  }

  const row = await prisma.job.findFirstOrThrow({
    where: { id: jobId, shop },
    select: {
      id: true,
      kind: true,
      status: true,
      attempts: true,
      maxAttempts: true,
      runAt: true,
      createdAt: true,
      finishedAt: true,
      lastError: true,
      correlationId: true,
      payload: true,
    },
  });

  log.info('Job requeued by hand', {
    jobId,
    shop,
    correlationId: row.correlationId,
  });

  return toSummary(row);
}
