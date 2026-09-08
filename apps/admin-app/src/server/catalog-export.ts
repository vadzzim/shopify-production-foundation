import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import {
  ROUTINE_STEPS,
  emptyStepCounts,
  type CatalogExportReport,
  type RoutineStep,
} from '@nordlys/shared';

import { unwrap, type AdminGraphql } from './admin-graphql';
import {
  BULK_OPERATION_STATUS,
  CATALOG_EXPORT_QUERY,
  START_CATALOG_EXPORT,
} from './graphql-documents';
import {
  createThrottleGate,
  type ThrottleGate,
  type ThrottleGateOptions,
} from './throttle';
import { enqueue } from './queue';
import { assertNoUserErrors, type ShopifyUserError } from './user-errors';

/**
 * The catalog export: a bulk operation, polled from the queue.
 *
 * Rule 4 says that for hundreds of objects or more the answer is a bulk
 * operation rather than paginating in a loop, and this is the app's one
 * question that needs the whole catalog: **which products carry which routine
 * step.** It cannot be narrowed by a `query:` filter, because the
 * `custom.routine_step` definition is not admin-filterable — so the honest
 * version of "how is my catalog set up for routine sets" is a full read, and a
 * full read does not belong in a request. ADR-0004 records the choice.
 *
 * Three properties of bulk operations shape everything below.
 *
 * **They are asynchronous.** `bulkOperationRunQuery` returns an id; the work
 * happens on Shopify's schedule and finishes minutes later. Nothing here waits
 * for that in one go — the job polls within a budget and asks the queue to come
 * back, so a long export never holds the worker away from the webhooks behind
 * it.
 *
 * **Starting one is not idempotent.** The queue is at-least-once, so a retry
 * that re-ran the mutation would start a second export of the same catalog.
 * The id is written to the job row before anything else, and a retry resumes
 * polling rather than starting again.
 *
 * **The result is a file, not a response.** JSONL over plain HTTPS from a
 * signed URL that expires in seven days, read as a stream: a catalog of a
 * hundred thousand products is a large file, and `await response.text()` would
 * put all of it in memory to count three numbers.
 */

/**
 * How many attempts a catalog export gets.
 *
 * More than the default five because most of them are not failures: a poll
 * whose budget ran out reschedules without spending an attempt, but a genuine
 * transport failure — Shopify unreachable while the operation is still running
 * — does spend one, and an export of a large catalog is alive for long enough
 * to meet a few.
 */
const EXPORT_MAX_ATTEMPTS = 10;

/**
 * Ask for a catalog export, unless one is already on its way.
 *
 * The check for an in-flight run is a convenience rather than a guarantee, and
 * the difference is worth stating: two merchants pressing the button at the
 * same moment can both pass it and enqueue. That is deliberate. Enforcing it
 * properly needs a partial unique index over a status set, and the cost of
 * losing the race is one extra read-only export — Shopify allows five
 * concurrent per app — which produces the same report. Rule 10 exists for
 * duplicates that corrupt state; this one does not.
 */
export async function requestCatalogExport(
  prisma: PrismaClient,
  shop: string,
): Promise<{ jobId: string; alreadyRunning: boolean }> {
  const inFlight = await prisma.job.findFirst({
    // FAILED counts as in flight: it has attempts left and a `runAt` in the
    // future, so the queue will come back to it.
    where: {
      shop,
      kind: 'catalog.export',
      status: { in: ['PENDING', 'RUNNING', 'FAILED'] },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  if (inFlight) return { jobId: inFlight.id, alreadyRunning: true };

  const jobId = await enqueue(prisma, {
    shop,
    kind: 'catalog.export',
    payload: {},
    // Webhook-driven jobs carry Shopify's delivery id here; this one has no
    // delivery behind it, so it mints an id whose prefix says where it came
    // from. The point of the field is that one line in the log can be followed
    // to every other line about the same piece of work.
    correlationId: `ui-${randomUUID()}`,
    maxAttempts: EXPORT_MAX_ATTEMPTS,
  });

  return { jobId, alreadyRunning: false };
}

/** `BulkOperationStatus` as of 2026-07. */
type BulkOperationStatus =
  | 'CREATED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'CANCELING'
  | 'CANCELED'
  | 'FAILED'
  | 'EXPIRED';

export interface BulkOperationState {
  id: string;
  status: BulkOperationStatus;
  errorCode: string | null;
  /** `UnsignedInt64`, which arrives as a string. */
  objectCount: string;
  url: string | null;
  partialDataUrl: string | null;
  completedAt: string | null;
}

interface StartExportData {
  bulkOperationRunQuery: {
    bulkOperation: { id: string; status: BulkOperationStatus } | null;
    userErrors: ShopifyUserError[];
  };
}

interface BulkOperationData {
  bulkOperation: BulkOperationState | null;
}

/** Raised when the operation itself ended badly. Not a transport failure. */
export class CatalogExportFailedError extends Error {
  readonly errorCode: string | null;
  readonly partialDataUrl: string | null;

  constructor(state: BulkOperationState) {
    super(
      `The catalog export ended as ${state.status}` +
        (state.errorCode ? ` (${state.errorCode})` : '') +
        (state.partialDataUrl
          ? '. Partial data was produced and is available for seven days.'
          : '.'),
    );
    this.name = 'CatalogExportFailedError';
    this.errorCode = state.errorCode;
    this.partialDataUrl = state.partialDataUrl;
  }
}

/**
 * Ask Shopify to run the export, and return the id it will be known by.
 *
 * Rule 2: `bulkOperationRunQuery` answers 200 with an empty `bulkOperation` and
 * a populated `userErrors` when it refuses the document — an invalid query, or
 * more operations already running than the app may have at once — and a caller
 * that only read `bulkOperation.id` would report a started export and then poll
 * `null` forever.
 */
export async function startCatalogExport(
  graphql: AdminGraphql,
): Promise<string> {
  const data = unwrap(
    'bulkOperationRunQuery',
    await graphql<StartExportData>(START_CATALOG_EXPORT, {
      query: CATALOG_EXPORT_QUERY,
    }),
  );

  assertNoUserErrors(
    'bulkOperationRunQuery',
    data.bulkOperationRunQuery.userErrors,
  );

  const operation = data.bulkOperationRunQuery.bulkOperation;

  if (!operation) {
    throw new Error(
      'Shopify accepted the bulk operation but returned no operation to poll.',
    );
  }

  return operation.id;
}

/**
 * One status check, with its cost reported to the gate that paces the loop.
 *
 * The gate is a parameter rather than a detail of the loop so that the first
 * check — the one outside the loop — is measured too. A gate that only learns
 * from the second call onwards would be pacing on a bucket reading it never saw.
 */
export async function fetchBulkOperation(
  graphql: AdminGraphql,
  id: string,
  gate?: Pick<ThrottleGate, 'record'>,
): Promise<BulkOperationState> {
  const response = await graphql<BulkOperationData>(BULK_OPERATION_STATUS, {
    id,
  });
  gate?.record(response.extensions?.cost);

  const data = unwrap('bulkOperation', response);

  if (!data.bulkOperation) {
    // Null for an id this token cannot resolve: an operation from another app,
    // or one old enough to have been pruned.
    throw new Error(`Shopify knows no bulk operation with id ${id}.`);
  }

  return data.bulkOperation;
}

export type CatalogExportOutcome =
  | { status: 'completed'; report: CatalogExportReport }
  /** Still working. How many objects it has written so far, for the log. */
  | { status: 'running'; objectCount: number };

export interface CatalogExportOptions {
  /** Injected for tests; the real one is `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests; the real one is the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** How long to wait between status checks. */
  pollIntervalMs?: number;
  /**
   * How long one attempt may spend polling.
   *
   * Deliberately well under the queue's stale-lock timeout, and short for a
   * second reason: the worker runs jobs one at a time, so every second spent
   * here is a second the webhook jobs behind this one are not moving.
   */
  pollBudgetMs?: number;
  /** Injected for tests; the real one is `Date.now`. */
  now?: () => number;
  throttle?: ThrottleGateOptions;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_BUDGET_MS = 30_000;

/**
 * Poll an operation this job has already started, and summarise it if it has
 * finished.
 *
 * Rule 4 applies to the polling itself: it is a loop of Admin API calls, so
 * each response feeds the throttle gate. The calls are cheap, but "cheap" is
 * not the rule.
 */
export async function runCatalogExport(
  graphql: AdminGraphql,
  bulkOperationId: string,
  options: CatalogExportOptions = {},
): Promise<CatalogExportOutcome> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollBudgetMs = options.pollBudgetMs ?? DEFAULT_POLL_BUDGET_MS;
  const gate = createThrottleGate(options.throttle ?? {});

  const deadline = now() + pollBudgetMs;
  let state = await fetchBulkOperation(graphql, bulkOperationId, gate);

  while (state.status === 'CREATED' || state.status === 'RUNNING') {
    if (now() >= deadline) {
      return { status: 'running', objectCount: Number(state.objectCount) };
    }

    await sleep(pollIntervalMs);
    await gate.beforeCall();
    state = await fetchBulkOperation(graphql, bulkOperationId, gate);
  }

  if (state.status !== 'COMPLETED' || !state.url) {
    // CANCELED, FAILED, EXPIRED — and COMPLETED with no url, which is what an
    // operation that matched nothing at all looks like.
    if (state.status !== 'COMPLETED') throw new CatalogExportFailedError(state);

    return {
      status: 'completed',
      report: emptyReport(bulkOperationId, state.completedAt),
    };
  }

  return {
    status: 'completed',
    report: await summariseCatalog(
      bulkOperationId,
      readLines(await download(state.url, options.fetchImpl ?? fetch)),
      state.completedAt,
    ),
  };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function emptyReport(
  bulkOperationId: string,
  completedAt: string | null,
): CatalogExportReport {
  return {
    bulkOperationId,
    objectCount: 0,
    byStep: emptyStepCounts(),
    withoutStep: 0,
    unrecognisedSteps: [],
    sampleWithoutStep: [],
    completedAt: completedAt ?? new Date().toISOString(),
  };
}

async function download(url: string, fetchImpl: typeof fetch) {
  const response = await fetchImpl(url);

  if (!response.ok) {
    throw new Error(
      `The bulk operation's result file answered ${String(response.status)}.`,
    );
  }

  return response;
}

/** How many products with no step the report names. */
const MAX_SAMPLE = 20;

interface ExportedProduct {
  id?: string;
  title?: string;
  status?: string;
  metafield?: { value?: string } | null;
}

/**
 * Turn the result file into the numbers a merchant reads.
 *
 * Lines are counted rather than trusting the operation's own `objectCount`, so
 * the report adds up: every product is in exactly one of `byStep`,
 * `unrecognisedSteps` and `withoutStep`, and their total is `objectCount`. Two
 * numbers from two sources that nearly agree is the sort of thing nobody can
 * explain a year later.
 */
export async function summariseCatalog(
  bulkOperationId: string,
  lines: AsyncIterable<string>,
  completedAt: string | null,
): Promise<CatalogExportReport> {
  const byStep = emptyStepCounts();
  const unrecognised = new Map<string, number>();
  const sampleWithoutStep: { productGid: string; title: string }[] = [];

  let objectCount = 0;
  let withoutStep = 0;
  let lineNumber = 0;

  for await (const line of lines) {
    lineNumber += 1;
    if (line.trim().length === 0) continue;

    let parsed: ExportedProduct;
    try {
      parsed = JSON.parse(line) as ExportedProduct;
    } catch {
      throw new Error(
        `Line ${String(lineNumber)} of the bulk result file is not JSON.`,
      );
    }

    // Everything this query asks for is a product. The guard is for the day
    // someone adds a nested connection: those rows arrive interleaved, tagged
    // with `__parentId`, and would otherwise be counted as products.
    if (!parsed.id?.startsWith('gid://shopify/Product/')) continue;

    objectCount += 1;

    const value = parsed.metafield?.value;

    if (!value) {
      withoutStep += 1;
      if (sampleWithoutStep.length < MAX_SAMPLE) {
        sampleWithoutStep.push({
          productGid: parsed.id,
          title: parsed.title ?? '(untitled)',
        });
      }
      continue;
    }

    const step = ROUTINE_STEPS.find(
      (candidate): candidate is RoutineStep => candidate === value,
    );

    if (step) {
      byStep[step] += 1;
    } else {
      unrecognised.set(value, (unrecognised.get(value) ?? 0) + 1);
    }
  }

  return {
    bulkOperationId,
    objectCount,
    byStep,
    withoutStep,
    unrecognisedSteps: [...unrecognised.entries()]
      .map(([value, count]) => ({ value, count }))
      .toSorted((a, b) => b.count - a.count),
    sampleWithoutStep,
    completedAt: completedAt ?? new Date().toISOString(),
  };
}

/**
 * The response body as lines, without holding the file in memory.
 *
 * `getReader()` rather than `for await (const chunk of body)`: the DOM's
 * `ReadableStream` type carries no async iterator, so iterating it directly
 * type-checks only by asserting something about the runtime that the types do
 * not promise.
 */
export async function* readLines(response: Response): AsyncGenerator<string> {
  const body = response.body;
  if (!body) return;

  // Annotated rather than inferred: `Response.body` is a `ReadableStream<any>`
  // in these type definitions, and an `any` here would spread through every
  // chunk the decoder is handed.
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  const decoder = new TextDecoder();
  let carry = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      carry += decoder.decode(value, { stream: true });

      let newline = carry.indexOf('\n');
      while (newline !== -1) {
        yield carry.slice(0, newline);
        carry = carry.slice(newline + 1);
        newline = carry.indexOf('\n');
      }
    }
  } finally {
    reader.releaseLock();
  }

  // A file that does not end in a newline still has a last product on it.
  carry += decoder.decode();
  if (carry.length > 0) yield carry;
}
