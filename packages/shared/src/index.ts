/**
 * The isomorphic half of the shared package: values and types that are equally
 * valid in the browser bundle, the Express server and the worker.
 *
 * Environment validation is deliberately not here. It reads `process.env`, so
 * exporting it from this entry point would put Node globals in the browser's
 * type graph and let a UI module import the server's secrets handling by
 * accident. It lives behind `@nordlys/shared/node` instead, where importing it
 * from browser code is a resolution error rather than a review comment.
 */
export { ADMIN_API_VERSION, type AdminApiVersion } from './api-version';
export {
  ROUTINE_STEPS,
  routineStepSchema,
  bundleStatusSchema,
  bundleItemSchema,
  bundleSchema,
  bundleListResponseSchema,
  definitionResultSchema,
  storeSetupReportSchema,
  apiErrorSchema,
  type RoutineStep,
  type BundleStatus,
  type BundleItem,
  type Bundle,
  type BundleListResponse,
  type DefinitionResult,
  type StoreSetupReport,
  type ApiError,
} from './bundle';
