import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import type { AdminGraphql } from './admin-graphql';
import {
  CatalogExportFailedError,
  fetchBulkOperation,
  readLines,
  requestCatalogExport,
  runCatalogExport,
  startCatalogExport,
  summariseCatalog,
} from './catalog-export';
import { UserErrorsError } from './user-errors';

/**
 * The catalog export, against a fake Shopify.
 *
 * What is worth testing here is not that the right document was sent — that is
 * checked against the schema by the Dev MCP — but the state machine around it:
 * an operation that is still running, one that failed, a result file read in
 * chunks, and the arithmetic of the report. None of those are reachable by
 * pressing the button once on a small store, which is exactly why they are the
 * cases that break in production.
 */

const SHOP = 'ecorn-oj1cb5ll.myshopify.com';
const OPERATION_ID = 'gid://shopify/BulkOperation/1';

interface OperationFixture {
  status: string;
  errorCode?: string | null;
  objectCount?: string;
  url?: string | null;
  partialDataUrl?: string | null;
  completedAt?: string | null;
}

function operation(fixture: OperationFixture) {
  return {
    id: OPERATION_ID,
    status: fixture.status,
    errorCode: fixture.errorCode ?? null,
    objectCount: fixture.objectCount ?? '0',
    url: fixture.url ?? null,
    partialDataUrl: fixture.partialDataUrl ?? null,
    completedAt: fixture.completedAt ?? null,
  };
}

/** Answers the status query with a scripted sequence of states. */
function fakeShopify(states: OperationFixture[]): {
  graphql: AdminGraphql;
  documents: string[];
} {
  const documents: string[] = [];
  let index = 0;

  const graphql: AdminGraphql = async (document) => {
    documents.push(document);

    if (document.includes('StartCatalogExport')) {
      return {
        data: {
          bulkOperationRunQuery: {
            bulkOperation: { id: OPERATION_ID, status: 'CREATED' },
            userErrors: [],
          },
        } as never,
      };
    }

    const state = states[Math.min(index, states.length - 1)];
    index += 1;

    return {
      data: { bulkOperation: operation(state ?? { status: 'RUNNING' }) } as never,
      extensions: {
        cost: {
          requestedQueryCost: 1,
          actualQueryCost: 1,
          throttleStatus: {
            maximumAvailable: 2000,
            currentlyAvailable: 1999,
            restoreRate: 100,
          },
        },
      },
    };
  };

  return { graphql, documents };
}

const noWait = {
  sleep: async () => {},
  pollIntervalMs: 0,
  throttle: { sleep: async () => {}, random: () => 0 },
};

function fileServing(body: string, status = 200): typeof fetch {
  return async () => new Response(body, { status });
}

function jsonl(
  products: {
    id: string;
    title?: string;
    step?: string | null;
  }[],
): string {
  return products
    .map((entry) =>
      JSON.stringify({
        id: entry.id,
        title: entry.title ?? 'A product',
        status: 'ACTIVE',
        ...(entry.step === undefined || entry.step === null
          ? {}
          : { metafield: { value: entry.step } }),
      }),
    )
    .join('\n');
}

describe('startCatalogExport', () => {
  it('returns the id the operation will be known by', async () => {
    const { graphql } = fakeShopify([]);

    expect(await startCatalogExport(graphql)).toBe(OPERATION_ID);
  });

  it('refuses to report a start that userErrors say did not happen', async () => {
    // Rule 2. The mutation answers 200 with a null operation and a reason, and
    // a caller that read only `bulkOperation.id` would poll null forever.
    const graphql: AdminGraphql = async () => ({
      data: {
        bulkOperationRunQuery: {
          bulkOperation: null,
          userErrors: [
            {
              field: ['query'],
              message: 'A bulk query operation is already running.',
            },
          ],
        },
      } as never,
    });

    await expect(startCatalogExport(graphql)).rejects.toBeInstanceOf(
      UserErrorsError,
    );
  });
});

describe('runCatalogExport', () => {
  it('polls until the operation completes, then reads the file', async () => {
    const { graphql } = fakeShopify([
      { status: 'RUNNING', objectCount: '10' },
      { status: 'RUNNING', objectCount: '90' },
      {
        status: 'COMPLETED',
        objectCount: '2',
        url: 'https://storage.example/results.jsonl',
        completedAt: '2026-09-08T12:00:00.000Z',
      },
    ]);

    const outcome = await runCatalogExport(graphql, OPERATION_ID, {
      ...noWait,
      fetchImpl: fileServing(
        jsonl([
          { id: 'gid://shopify/Product/1', step: 'cleanse' },
          { id: 'gid://shopify/Product/2', step: null },
        ]),
      ),
    });

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;

    expect(outcome.report).toMatchObject({
      bulkOperationId: OPERATION_ID,
      objectCount: 2,
      withoutStep: 1,
      completedAt: '2026-09-08T12:00:00.000Z',
    });
    expect(outcome.report.byStep.cleanse).toBe(1);
  });

  it('gives the worker back when its polling budget runs out', async () => {
    // The queue runs jobs one at a time, so an export that takes ten minutes
    // must not hold the webhook jobs behind it for ten minutes. It is not a
    // failure: the caller turns this into a reschedule.
    const { graphql } = fakeShopify([{ status: 'RUNNING', objectCount: '42' }]);

    let clock = 0;
    const outcome = await runCatalogExport(graphql, OPERATION_ID, {
      ...noWait,
      pollBudgetMs: 100,
      now: () => {
        clock += 60;
        return clock;
      },
    });

    expect(outcome).toEqual({ status: 'running', objectCount: 42 });
  });

  it('reports a failed operation with its error code and partial data', async () => {
    const { graphql } = fakeShopify([
      {
        status: 'FAILED',
        errorCode: 'TIMEOUT',
        partialDataUrl: 'https://storage.example/partial.jsonl',
      },
    ]);

    try {
      await runCatalogExport(graphql, OPERATION_ID, noWait);
      expect.unreachable('runCatalogExport should have thrown');
    } catch (error) {
      const failure = error as CatalogExportFailedError;
      expect(failure).toBeInstanceOf(CatalogExportFailedError);
      expect(failure.errorCode).toBe('TIMEOUT');
      expect(failure.message).toContain('Partial data');
    }
  });

  it('treats a completed operation with no file as an empty catalog', async () => {
    // Shopify leaves `url` null when the query matched nothing at all. That is
    // an answer, not a failure — the store has no active products.
    const { graphql } = fakeShopify([
      { status: 'COMPLETED', url: null, completedAt: '2026-09-08T12:00:00.000Z' },
    ]);

    const outcome = await runCatalogExport(graphql, OPERATION_ID, noWait);

    expect(outcome).toMatchObject({
      status: 'completed',
      report: { objectCount: 0, withoutStep: 0 },
    });
  });

  it('fails loudly when the result file cannot be downloaded', async () => {
    const { graphql } = fakeShopify([
      {
        status: 'COMPLETED',
        url: 'https://storage.example/expired.jsonl',
        completedAt: '2026-09-08T12:00:00.000Z',
      },
    ]);

    await expect(
      runCatalogExport(graphql, OPERATION_ID, {
        ...noWait,
        // What an expired URL looks like: the operation succeeded and its
        // result is gone, seven days later.
        fetchImpl: fileServing('<Error>AccessDenied</Error>', 403),
      }),
    ).rejects.toThrow('403');
  });
});

describe('fetchBulkOperation', () => {
  it('refuses an id Shopify does not recognise', async () => {
    const graphql: AdminGraphql = async () => ({
      data: { bulkOperation: null } as never,
    });

    await expect(
      fetchBulkOperation(graphql, OPERATION_ID),
    ).rejects.toThrow('knows no bulk operation');
  });
});

describe('summariseCatalog', () => {
  async function* lines(text: string) {
    for (const line of text.split('\n')) yield line;
  }

  it('adds up: every product is counted exactly once', async () => {
    const report = await summariseCatalog(
      OPERATION_ID,
      lines(
        jsonl([
          { id: 'gid://shopify/Product/1', step: 'cleanse' },
          { id: 'gid://shopify/Product/2', step: 'cleanse' },
          { id: 'gid://shopify/Product/3', step: 'treat' },
          { id: 'gid://shopify/Product/4', step: 'moisturise' },
          { id: 'gid://shopify/Product/5', step: null },
        ]),
      ),
      '2026-09-08T12:00:00.000Z',
    );

    const counted =
      Object.values(report.byStep).reduce((sum, count) => sum + count, 0) +
      report.unrecognisedSteps.reduce((sum, entry) => sum + entry.count, 0) +
      report.withoutStep;

    expect(counted).toBe(report.objectCount);
    expect(report.objectCount).toBe(5);
  });

  it('names the misspelled metafield values rather than ignoring them', async () => {
    // "moisturise" is invisible to every other screen in this app: the theme
    // filters on the exact choice-list value, so the product simply never
    // appears. Being told is the only way a merchant finds out.
    const report = await summariseCatalog(
      OPERATION_ID,
      lines(
        jsonl([
          { id: 'gid://shopify/Product/1', step: 'moisturise' },
          { id: 'gid://shopify/Product/2', step: 'moisturise' },
          { id: 'gid://shopify/Product/3', step: 'exfoliate' },
        ]),
      ),
      null,
    );

    expect(report.unrecognisedSteps).toEqual([
      { value: 'moisturise', count: 2 },
      { value: 'exfoliate', count: 1 },
    ]);
  });

  it('names at most twenty products with no step', async () => {
    const many = Array.from({ length: 25 }, (_unused, index) => ({
      id: `gid://shopify/Product/${String(index)}`,
      step: null,
    }));

    const report = await summariseCatalog(OPERATION_ID, lines(jsonl(many)), null);

    expect(report.withoutStep).toBe(25);
    expect(report.sampleWithoutStep).toHaveLength(20);
  });

  it('ignores rows that are not products', async () => {
    // The guard for the day someone adds a nested connection to the query:
    // child rows arrive interleaved and tagged with __parentId.
    const report = await summariseCatalog(
      OPERATION_ID,
      lines(
        [
          JSON.stringify({
            id: 'gid://shopify/Product/1',
            title: 'A product',
            metafield: { value: 'treat' },
          }),
          JSON.stringify({
            id: 'gid://shopify/ProductVariant/9',
            __parentId: 'gid://shopify/Product/1',
          }),
        ].join('\n'),
      ),
      null,
    );

    expect(report.objectCount).toBe(1);
  });

  it('refuses a result file that is not JSONL, naming the line', async () => {
    await expect(
      summariseCatalog(OPERATION_ID, lines('{"id": "gid://shopify/Product/1"}\nnot json'), null),
    ).rejects.toThrow('Line 2');
  });
});

describe('readLines', () => {
  it('yields the last line of a file that does not end in a newline', async () => {
    const collected: string[] = [];

    for await (const line of readLines(new Response('one\ntwo\nthree'))) {
      collected.push(line);
    }

    expect(collected).toEqual(['one', 'two', 'three']);
  });

  it('reassembles a line split across two chunks', async () => {
    // The reason this function exists rather than `await response.text()`: a
    // large catalog arrives in chunks that fall wherever the network puts
    // them, which is routinely in the middle of a product.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('{"id":"a"}\n{"id":'));
        controller.enqueue(encoder.encode('"b"}\n'));
        controller.close();
      },
    });

    const collected: string[] = [];
    for await (const line of readLines(new Response(stream))) {
      collected.push(line);
    }

    expect(collected).toEqual(['{"id":"a"}', '{"id":"b"}']);
  });
});

describe('requestCatalogExport', () => {
  function fakePrisma(inFlight: { id: string } | null) {
    const created: unknown[] = [];

    const prisma = {
      job: {
        findFirst: async () => inFlight,
        create: async ({ data }: { data: unknown }) => {
          created.push(data);
          return { id: 'job_new' };
        },
      },
    } as unknown as PrismaClient;

    return { prisma, created };
  }

  it('enqueues one job with a correlation id that says where it came from', async () => {
    const { prisma, created } = fakePrisma(null);

    const result = await requestCatalogExport(prisma, SHOP);

    expect(result).toEqual({ jobId: 'job_new', alreadyRunning: false });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      shop: SHOP,
      kind: 'catalog.export',
      correlationId: expect.stringMatching(/^ui-/),
    });
  });

  it('does not start a second export while one is in flight', async () => {
    const { prisma, created } = fakePrisma({ id: 'job_running' });

    const result = await requestCatalogExport(prisma, SHOP);

    expect(result).toEqual({ jobId: 'job_running', alreadyRunning: true });
    expect(created).toHaveLength(0);
  });
});
