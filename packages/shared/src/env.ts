import { z } from 'zod';

/**
 * Environment validation.
 *
 * Rule 5 of `CLAUDE.md`: secrets come from `process.env` and nowhere else, and
 * the whole environment is validated with zod *at startup*. The point of
 * validating at startup rather than at first use is failure timing. An app that
 * reads `process.env.SHOPIFY_API_SECRET` when the first webhook arrives is a
 * deployment that looks healthy for an hour and then fails on live traffic,
 * inside a handler, with a stack trace that points at the HMAC check rather
 * than at the missing variable. Failing in the first hundred milliseconds turns
 * a production incident into a start-up error.
 *
 * `SHOPIFY_ADMIN_API_VERSION` is deliberately absent: see
 * {@link ./api-version.ts} and ADR-0009.
 */

const commaSeparated = z
  .string()
  .min(1)
  .transform((value) =>
    value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  )
  .pipe(z.array(z.string()).nonempty());

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  SHOPIFY_API_KEY: z.string().min(1),
  SHOPIFY_API_SECRET: z.string().min(1),

  /**
   * The app's public origin — the tunnel URL in development. Embedded apps are
   * loaded in an iframe inside the Shopify admin, which is served over HTTPS,
   * so a plain-http app URL is refused by the browser rather than by us. A
   * trailing slash is stripped because the value is concatenated with paths.
   */
  SHOPIFY_APP_URL: z
    .url({ protocol: /^https$/ })
    .transform((value) => value.replace(/\/+$/, '')),

  SHOPIFY_SCOPES: commaSeparated,

  SHOPIFY_STORE: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/,
      'must be a myshopify.com domain, for example ecorn-oj1cb5ll.myshopify.com',
    ),

  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'must be a PostgreSQL connection string'),
});

export type Env = z.infer<typeof envSchema>;

/** Thrown when the environment does not satisfy {@link envSchema}. */
export class EnvValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `Invalid environment. Fix these and start again ` +
        `(the full list of variables is in .env.example):\n` +
        issues.map((issue) => `  - ${issue}`).join('\n'),
    );
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/**
 * Validate and return the environment.
 *
 * Every problem is reported at once. Reporting only the first one turns a
 * fresh checkout into a guessing game: fix a variable, start again, discover
 * the next.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => {
        const name = issue.path.join('.') || '(root)';
        return `${name}: ${issue.message}`;
      }),
    );
  }

  return result.data;
}
