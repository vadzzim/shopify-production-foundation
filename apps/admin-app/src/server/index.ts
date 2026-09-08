/**
 * Process entry point.
 *
 * Importing `./env` is the first thing that happens, and that is not
 * incidental: `loadEnv` runs at module load, so a missing or malformed variable
 * stops the process here, before a port is bound or a database connection is
 * opened (rule 5). The alternative — reading `process.env` where it is needed —
 * produces a server that starts, passes its health check, and then fails on the
 * first real request, in a handler, with a stack trace pointing somewhere else.
 */
import { env } from './env';
import { createApp } from './app';
import { prisma } from './db';
import { logger, setLogLevel } from './logger';
import { offlineGraphqlFor } from './shopify';
import { createWorker } from './worker';

setLogLevel(env.LOG_LEVEL);

const app = await createApp();

/**
 * The queue worker runs in this process (ADR-0008).
 *
 * One deployment rather than two, and the jobs it runs are rows in the same
 * database the request handlers already write to. The cost is real and worth
 * naming: a slow job shares an event loop with the HTTP server, so the batch
 * size is small and extracting the worker into its own process is on the v2
 * roadmap rather than assumed away.
 */
const worker = createWorker({
  prisma,
  graphqlFor: offlineGraphqlFor,
  log: logger,
});

void worker.start();

const server = app.listen(env.PORT, () => {
  logger.info('admin-app listening', {
    url: `http://localhost:${String(env.PORT)}`,
    embeddedAt: env.SHOPIFY_APP_URL,
  });
});

/**
 * Shut down without abandoning a job mid-flight.
 *
 * A worker killed while holding a job leaves the row RUNNING with nobody
 * running it. The reaper in `queue.ts` recovers those, but only after the lock
 * has gone stale — minutes during which the work simply does not happen. Asking
 * the loop to stop and letting the current tick finish costs a second at
 * shutdown and avoids that entirely.
 *
 * `tsx watch` sends SIGTERM on every save, so this path runs constantly in
 * development, which is the best way to be sure it works.
 */
function shutdown(signal: string): void {
  logger.info('Shutting down', { signal });
  worker.stop();
  server.close(() => {
    void prisma.$disconnect().then(() => process.exit(0));
  });
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
