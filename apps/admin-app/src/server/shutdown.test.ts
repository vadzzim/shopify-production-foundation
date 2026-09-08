import { describe, expect, it, vi } from 'vitest';

import { logger } from './logger';
import { createShutdown, type ShutdownDeps } from './shutdown';

/**
 * The shutdown sequence.
 *
 * What is asserted is an *order*: the database connection may not be closed
 * while either the HTTP server or the queue worker is still using it. That is
 * exactly the kind of thing no manual check would catch — a SIGTERM that
 * arrives while no job is running looks perfectly clean — so it is recorded
 * here as a sequence of events rather than as a set of calls that happened.
 */

interface Harness {
  shutdown: (signal: string) => Promise<void>;
  events: string[];
  finishWorker: () => void;
  finishServer: () => void;
  exitCodes: number[];
}

function harness(options: { graceMs?: number } = {}): Harness {
  const events: string[] = [];
  const exitCodes: number[] = [];

  let finishWorker = (): void => {};
  let finishServer = (): void => {};

  const workerLoop = new Promise<void>((resolve) => {
    finishWorker = () => {
      events.push('worker stopped');
      resolve();
    };
  });

  const deps: ShutdownDeps = {
    worker: {
      stop: () => {
        events.push('worker asked to stop');
      },
    },
    workerLoop,
    server: {
      close: (callback) => {
        finishServer = () => {
          events.push('server closed');
          callback();
        };
      },
    },
    disconnect: async () => {
      events.push('database disconnected');
    },
    log: logger,
    ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
    exit: (code) => {
      events.push('exited');
      exitCodes.push(code);
    },
  };

  return {
    shutdown: createShutdown(deps),
    events,
    finishWorker: () => {
      finishWorker();
    },
    finishServer: () => {
      finishServer();
    },
    exitCodes,
  };
}

describe('createShutdown', () => {
  it('waits for the worker loop before closing the database', async () => {
    // The defect this replaced: `worker.stop()` only sets a flag, so a shutdown
    // that did not await the loop disconnected Prisma and exited while a
    // handler was mid-request to Shopify.
    const { shutdown, events, finishWorker, finishServer } = harness();

    const done = shutdown('SIGTERM');
    finishServer();

    // The server is closed and the worker is not: nothing may have been torn
    // down yet.
    await Promise.resolve();
    expect(events).toEqual(['worker asked to stop', 'server closed']);

    finishWorker();
    await done;

    expect(events).toEqual([
      'worker asked to stop',
      'server closed',
      'worker stopped',
      'database disconnected',
      'exited',
    ]);
  });

  it('waits for the HTTP server too', async () => {
    const { shutdown, events, finishWorker, finishServer } = harness();

    const done = shutdown('SIGTERM');
    finishWorker();

    await Promise.resolve();
    expect(events).not.toContain('database disconnected');

    finishServer();
    await done;

    expect(events).toContain('database disconnected');
  });

  it('gives up after the grace period rather than hanging', async () => {
    // An orchestrator sends SIGKILL a few seconds after SIGTERM regardless, so
    // an unbounded wait is a kill with less in the logs.
    const { shutdown, events, finishServer, exitCodes } = harness({
      graceMs: 5,
    });

    const done = shutdown('SIGTERM');
    finishServer();
    // The worker never finishes: a job stuck in a slow call.
    await done;

    expect(events).toEqual([
      'worker asked to stop',
      'server closed',
      'database disconnected',
      'exited',
    ]);
    // Still zero: the process was asked to stop, and a slow shutdown is not a
    // crash. The abandoned job is the reaper's to recover.
    expect(exitCodes).toEqual([0]);
  });

  it('ignores a second signal instead of tearing down twice', async () => {
    const { shutdown, events, finishWorker, finishServer } = harness();

    const first = shutdown('SIGTERM');
    await shutdown('SIGINT');

    finishServer();
    finishWorker();
    await first;

    expect(events.filter((event) => event === 'database disconnected')).toEqual(
      ['database disconnected'],
    );
  });

  it('does not leave a timer holding the process open', async () => {
    // `setTimeout` for the grace period is unref'd: work that finishes early
    // must not have to sit out the rest of the window.
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const { shutdown, finishWorker, finishServer } = harness({ graceMs: 60_000 });

    const done = shutdown('SIGTERM');
    finishServer();
    finishWorker();
    await done;

    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });
});
