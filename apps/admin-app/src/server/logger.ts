/**
 * A deliberately small logger.
 *
 * Structured logging with pino, and a correlation id carried from webhook
 * receipt through to the Admin API call, is phase 3 work (see the roadmap).
 * Adding pino now would be a dependency the app does not yet use meaningfully,
 * so this covers levels and nothing else. It is one file to replace when the
 * real thing arrives.
 *
 * It reads no environment of its own on purpose. Importing the validated `env`
 * here would drag env validation into every module that logs — including the
 * ones under test — and a unit test would then need a populated `.env` to run.
 * The level is set once from the entry point instead.
 */
const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LEVELS)[number];

let threshold = LEVELS.indexOf('info');

export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS.indexOf(level);
}

function emit(level: LogLevel, message: string, detail?: unknown): void {
  if (LEVELS.indexOf(level) > threshold) return;

  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  const write = level === 'error' || level === 'fatal' ? console.error : console.log;

  if (detail === undefined) {
    write(line);
  } else {
    write(line, detail);
  }
}

export const logger = {
  fatal: (message: string, detail?: unknown) => emit('fatal', message, detail),
  error: (message: string, detail?: unknown) => emit('error', message, detail),
  warn: (message: string, detail?: unknown) => emit('warn', message, detail),
  info: (message: string, detail?: unknown) => emit('info', message, detail),
  debug: (message: string, detail?: unknown) => emit('debug', message, detail),
  trace: (message: string, detail?: unknown) => emit('trace', message, detail),
};
