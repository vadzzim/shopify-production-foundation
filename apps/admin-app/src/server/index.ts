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
import { logger, setLogLevel } from './logger';

setLogLevel(env.LOG_LEVEL);

const app = await createApp();

app.listen(env.PORT, () => {
  logger.info(`admin-app listening on http://localhost:${env.PORT}`);
  logger.info(`Embedded at ${env.SHOPIFY_APP_URL}`);
});
