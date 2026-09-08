import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadEnv, type Env } from '@nordlys/shared/node';

import { withCliAliases } from './cli-env-aliases';

/**
 * Where the environment comes from, in order of precedence.
 *
 * 1. What the process was actually handed, including Shopify CLI's names for
 *    values this project calls something else (`HOST`, `SCOPES`).
 * 2. `.env` at the repository root, for anything the process was not handed.
 *
 * The order matters, and getting it wrong is a trap with a confusing symptom.
 * `shopify app dev` passes the tunnel URL as `HOST`, not as `SHOPIFY_APP_URL`.
 * If `.env` were read first, a `SHOPIFY_APP_URL` left over from a previous
 * session would satisfy the schema, the alias would never fire, and the app
 * would run against a tunnel that closed yesterday — OAuth redirecting to a
 * dead host while the CLI reports a healthy start. So the aliases are resolved
 * from the pristine environment *before* the file is loaded, and win over it.
 *
 * `process.loadEnvFile` never overwrites a variable that is already set, which
 * is the same precedence applied to everything else.
 *
 * The path is resolved from this module rather than from `process.cwd()`
 * because the working directory differs between `pnpm dev` at the root,
 * `pnpm --filter admin-app dev`, and the CLI running the dev command from
 * `apps/admin-app`. Node 24 reads env files natively, so there is no dotenv
 * dependency.
 */
const envFile = fileURLToPath(new URL('../../../../.env', import.meta.url));

const fromProcess = withCliAliases(process.env);

if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

export const env: Env = loadEnv({ ...process.env, ...fromProcess });
