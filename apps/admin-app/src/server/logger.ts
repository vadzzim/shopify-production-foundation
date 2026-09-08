import pino, { type Logger as PinoLogger } from 'pino';

/**
 * Structured logging, and the correlation id that makes it useful.
 *
 * The point of pino here is not the JSON. It is that a webhook delivery can be
 * followed from the moment it arrives to the Admin API call it eventually
 * causes, across a queue and a worker tick that happen after the HTTP response
 * has already gone back to Shopify. Once work is deferred, the stack trace stops
 * being the thread that ties events together, and a shared field has to take
 * over that job.
 *
 * So every log line a delivery produces carries the same `correlationId`. It is
 * minted in the receiver, stored on the job row, and restored by the worker when
 * the job is claimed — which is why it survives the process restarting between
 * the two. `grep` on one id yields the whole life of one delivery.
 *
 * The correlation id is passed explicitly, as a child logger handed down the
 * call chain, rather than through `AsyncLocalStorage`. Both work; explicit
 * passing is the one this codebase can test, because it matches how every other
 * dependency here is injected — a handler takes its logger as an argument and a
 * test reads what it wrote.
 *
 * This module still reads no environment of its own. Importing the validated
 * `env` here would pull env validation into every module that logs, including
 * the ones under test, and a unit test would then need a populated `.env` just
 * to construct a logger. The level is set once from the entry point.
 */

export type LogLevel =
  | 'fatal'
  | 'error'
  | 'warn'
  | 'info'
  | 'debug'
  | 'trace';

export interface LogFields {
  correlationId?: string;
  shop?: string;
  topic?: string;
  jobId?: string;
  jobKind?: string;
  [key: string]: unknown;
}

/**
 * The surface the rest of the app depends on.
 *
 * Narrower than pino's own: a handler that takes a `Logger` can be handed a
 * recording fake in a test without implementing the thirty members of
 * `pino.Logger`. Same reason `AdminGraphql` is one function rather than the
 * SDK's client.
 */
export interface Logger {
  fatal(message: string, detail?: LogFields): void;
  error(message: string, detail?: LogFields): void;
  warn(message: string, detail?: LogFields): void;
  info(message: string, detail?: LogFields): void;
  debug(message: string, detail?: LogFields): void;
  trace(message: string, detail?: LogFields): void;
  /** A logger that stamps `fields` on every line it and its children write. */
  child(fields: LogFields): Logger;
}

/**
 * Pretty output is not configured, and that is deliberate.
 *
 * `pino-pretty` would make development output nicer at the cost of a transport
 * worker thread and a dependency whose failure mode is losing log lines on
 * exit. `pnpm dev | npx pino-pretty` gets the same result outside the process,
 * which is how pino itself recommends it. Documented in docs/development.md.
 */
const root: PinoLogger = pino({
  level: 'info',
  // Shopify's own log lines (the SDK's) go through config.logger and are not
  // JSON; these are, so the two are told apart by shape in a terminal.
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    // An offline access token in a log line is a credential in a log
    // aggregator, and it does not expire. These paths cover the places a
    // Session or an OAuth response could reach a log line from.
    paths: [
      'accessToken',
      'session.accessToken',
      'refreshToken',
      'session.refreshToken',
      'headers.authorization',
      'headers["x-shopify-hmac-sha256"]',
    ],
    censor: '[redacted]',
  },
});

function wrap(instance: PinoLogger): Logger {
  const at =
    (level: LogLevel) =>
    (message: string, detail?: LogFields): void => {
      // pino's signature is (mergeObject, message); passing the message alone
      // when there is no detail keeps the `msg` field clean of an empty object.
      if (detail === undefined) {
        instance[level](message);
      } else {
        instance[level](detail, message);
      }
    };

  return {
    fatal: at('fatal'),
    error: at('error'),
    warn: at('warn'),
    info: at('info'),
    debug: at('debug'),
    trace: at('trace'),
    child: (fields) => wrap(instance.child(fields)),
  };
}

export const logger: Logger = wrap(root);

/**
 * `'silent'` is accepted here but is not a value `LOG_LEVEL` can take: the env
 * schema lists the six real levels, because a deployment configured to log
 * nothing is a deployment nobody can debug. The test setup uses it so that a
 * suite which deliberately exercises the failure paths does not bury the
 * reporter's output in the errors it asked for.
 */
export function setLogLevel(level: LogLevel | 'silent'): void {
  root.level = level;
}

/**
 * A correlation id for one webhook delivery.
 *
 * Shopify's own `X-Shopify-Webhook-Id` is used when there is one — reusing the
 * platform's identifier means a line in our logs and a row in Shopify's webhook
 * delivery log can be matched without a lookup table. This exists for the
 * enqueue paths that have no delivery behind them, such as a retry from the
 * sync log.
 */
export function newCorrelationId(): string {
  return crypto.randomUUID();
}
