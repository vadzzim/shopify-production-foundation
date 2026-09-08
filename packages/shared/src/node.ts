/**
 * The Node-only half of the shared package.
 *
 * Split from the main entry point so the browser bundle cannot reach it: env
 * validation touches `process.env`, and an import of it from UI code should
 * fail to resolve rather than be caught in review.
 */
export { envSchema, loadEnv, EnvValidationError, type Env } from './env';
