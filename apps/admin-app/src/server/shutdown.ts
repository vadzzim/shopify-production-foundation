import type { Logger } from './logger';

/**
 * Stopping this process without abandoning work half-done.
 *
 * There are two things running here (ADR-0008): the HTTP server and the queue
 * worker. Both have to be finished with before the database connection they
 * share is closed, and only one of them is something `server.close()` knows
 * about — which is where this used to go wrong. Asking the worker to stop set a
 * flag on its loop and returned immediately, so a SIGTERM arriving mid-job
 * disconnected Prisma and called `process.exit` while a handler was still
 * talking to Shopify. The job died at whatever statement it had reached,
 * leaving the row RUNNING for the reaper to find minutes later, which is
 * precisely what the graceful shutdown was written to avoid.
 *
 * So the loop's promise is awaited, not just signalled. `worker.start()`
 * resolves once the current tick has finished and the loop has seen the flag,
 * which is the moment nothing is running any more.
 *
 * ## The grace period
 *
 * Waiting has to be bounded. A catalog export polls a bulk operation for up to
 * half a minute per attempt, and an orchestrator that sent SIGTERM will send
 * SIGKILL a few seconds later regardless of what this process would have
 * preferred — so a shutdown that waits indefinitely is a shutdown that gets
 * killed anyway, with less notice in the logs. When the grace period runs out
 * the process goes down the old way and says so at warning level, which is the
 * signal that the window is too short for the work this deploy is doing.
 *
 * The exit code stays 0 even then. The process is being asked to stop, and
 * exiting non-zero would present a normal shutdown that ran slow as a crash to
 * whatever is watching. The abandoned job is not lost — the reaper releases it,
 * and now dead-letters it if it has no attempts left.
 */

/** Just enough of `http.Server` to close it, so a test can pass a fake. */
export interface ClosableServer {
  close(callback: (error?: Error) => void): void;
}

export interface ShutdownDeps {
  /** Asks the worker's poll loop to finish its current tick and exit. */
  worker: { stop: () => void };
  /**
   * The promise `worker.start()` returned.
   *
   * The whole point: without it there is nothing to wait for, and a flag set on
   * a loop nobody awaits is indistinguishable from no shutdown handling at all.
   */
  workerLoop: Promise<void>;
  server: ClosableServer;
  disconnect: () => Promise<void>;
  log: Logger;
  /** How long to wait for the two of them. */
  graceMs?: number;
  /** Injected for tests; the real one is `process.exit`. */
  exit?: (code: number) => void;
}

const DEFAULT_GRACE_MS = 10_000;

export function createShutdown(
  deps: ShutdownDeps,
): (signal: string) => Promise<void> {
  const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  let started = false;

  return async function shutdown(signal: string): Promise<void> {
    if (started) {
      // A second SIGTERM, or a SIGINT after one. Re-entering would close the
      // server twice and race two `$disconnect` calls; the operator pressing
      // Ctrl-C again wants it to be over, and it is already on its way.
      deps.log.warn('Already shutting down; ignoring', { signal });
      return;
    }
    started = true;

    deps.log.info('Shutting down', { signal });
    deps.worker.stop();

    const closed = new Promise<void>((resolve) => {
      deps.server.close(() => {
        resolve();
      });
    });

    let expiry: NodeJS.Timeout | undefined;

    const graceExpired = new Promise<'expired'>((resolve) => {
      expiry = setTimeout(() => {
        resolve('expired');
      }, graceMs);
      // Nothing should be kept alive by this timer: if the work finishes first,
      // the process must be free to exit rather than sitting out the rest of
      // the grace period.
      expiry.unref();
    });

    const outcome = await Promise.race([
      Promise.all([closed, deps.workerLoop]).then(() => 'drained' as const),
      graceExpired,
    ]);

    if (expiry) clearTimeout(expiry);

    if (outcome === 'expired') {
      deps.log.warn(
        'Grace period expired with work still running; exiting anyway',
        { graceMs },
      );
    }

    // Last, and only now: a disconnect while a handler still holds a query is
    // the failure this whole function exists to prevent.
    await deps.disconnect();
    exit(0);
  };
}
