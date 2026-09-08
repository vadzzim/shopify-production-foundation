import { z } from 'zod';

/**
 * The bundle domain, shared by the server and the browser bundle so that one
 * definition types both ends of every request.
 */

/**
 * The three routine steps.
 *
 * These strings are not ours to choose: they are the exact values of the
 * `custom.routine_step` metafield's choice list on the store (ADR-0003), and
 * the theme's `bundle-builder` section filters on them. Changing one here
 * without changing the metafield definition produces a bundle that silently
 * matches no products.
 */
export const ROUTINE_STEPS = ['cleanse', 'treat', 'moisturize'] as const;

export const routineStepSchema = z.enum(ROUTINE_STEPS);
export type RoutineStep = z.infer<typeof routineStepSchema>;

export const bundleStatusSchema = z.enum(['draft', 'active', 'archived']);
export type BundleStatus = z.infer<typeof bundleStatusSchema>;

/**
 * A product as the admin screen needs it: our stored reference plus the fields
 * that only Shopify knows. `title` and `status` are read live from the Admin
 * API on every request rather than cached alongside the bundle — a title cached
 * in our database goes stale the moment a merchant renames the product, and a
 * bundle screen showing a name the admin no longer uses is worse than a slower
 * screen.
 */
export const bundleItemSchema = z.object({
  productGid: z.string().min(1),
  routineStep: routineStepSchema,
  position: z.number().int().min(0),
  /** Absent when the product has been deleted in Shopify since it was added. */
  title: z.string().nullable(),
  productStatus: z.enum(['ACTIVE', 'ARCHIVED', 'DRAFT']).nullable(),
});
export type BundleItem = z.infer<typeof bundleItemSchema>;

export const bundleSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  handle: z.string().min(1),
  status: bundleStatusSchema,
  updatedAt: z.iso.datetime(),
  items: z.array(bundleItemSchema),
});
export type Bundle = z.infer<typeof bundleSchema>;

export const bundleListResponseSchema = z.object({
  bundles: z.array(bundleSchema),
});
export type BundleListResponse = z.infer<typeof bundleListResponseSchema>;

/**
 * The shape every failing endpoint returns.
 *
 * A single envelope exists so the UI can render an error without parsing prose:
 * `message` is shown to the merchant, `code` decides whether the screen offers
 * a retry, and `detail` carries the `userErrors` entries a Shopify mutation
 * came back with so they are visible rather than swallowed.
 */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum([
      'unauthenticated',
      'shopify_api',
      'validation',
      'not_found',
      'internal',
    ]),
    message: z.string().min(1),
    detail: z.array(z.string()).optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/**
 * The result of the app preparing the store: one entry per definition it is
 * responsible for. Shared because the screen renders it directly — "created"
 * and "already present" are both successes, and the merchant should be able to
 * see which happened.
 */
export const definitionResultSchema = z.object({
  definition: z.string().min(1),
  outcome: z.enum(['created', 'already_present']),
  note: z.string().optional(),
});
export type DefinitionResult = z.infer<typeof definitionResultSchema>;

export const storeSetupReportSchema = z.object({
  results: z.array(definitionResultSchema),
  throttleWaitMs: z.number().min(0),
});
export type StoreSetupReport = z.infer<typeof storeSetupReportSchema>;
