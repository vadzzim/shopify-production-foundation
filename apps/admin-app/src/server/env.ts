import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadEnv, type Env } from '@nordlys/shared/node';

/**
 * `.env` lives at the repository root, next to `docker-compose.yml`, so the app
 * and the Prisma CLI read one file. The path is resolved from this module
 * rather than from `process.cwd()` because the working directory differs
 * between `pnpm dev` at the root and `pnpm --filter admin-app dev`.
 *
 * Node 24 reads env files natively (`process.loadEnvFile`), so there is no
 * dotenv dependency. Values already present in the real environment win — that
 * is what makes a CI run or a container ignore a developer's local file.
 */
const envFile = fileURLToPath(new URL('../../../../.env', import.meta.url));

if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

export const env: Env = loadEnv();
