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
 * One slot of a bundle as the merchant submits it.
 *
 * Only the two fields the merchant actually chooses. `position` is not among
 * them: it is derived from the order of {@link ROUTINE_STEPS}, because a
 * routine is a sequence — cleanse, then treat, then moisturize — and letting a
 * client send its own ordering would allow a set that says "moisturize first"
 * to be stored and rendered. `title` and `productStatus` are not among them
 * either; they are Shopify's, read live, and accepting them from the browser
 * would let a caller decide what a product is called.
 */
export const bundleItemInputSchema = z.object({
  productGid: z.string().startsWith('gid://shopify/Product/'),
  routineStep: routineStepSchema,
});
export type BundleItemInput = z.infer<typeof bundleItemInputSchema>;

/**
 * A change to an existing bundle. Every field is optional; sending none is an
 * error rather than a no-op, because a request that changes nothing is a bug in
 * the caller and answering it 200 hides that.
 *
 * **`handle` is absent on purpose.** It is the identifier the storefront links
 * a routine set by, so renaming a set must not silently move its URL — the two
 * are separate decisions, and only one of them is what a merchant means when
 * they fix a typo in a title.
 */
export const bundleUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(255).optional(),
    status: bundleStatusSchema.optional(),
    items: z.array(bundleItemInputSchema).optional(),
  })
  .superRefine((update, ctx) => {
    if (
      update.title === undefined &&
      update.status === undefined &&
      update.items === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'The request changes nothing: send a title, a status or items.',
      });
    }

    if (update.items === undefined) return;

    // A routine set is exactly one product per step. The database says the same
    // thing with a unique index on `[bundleId, routineStep]`, and this check is
    // not a substitute for it — it is what turns a constraint violation deep in
    // a transaction into a message naming the step that is missing or repeated.
    const steps = update.items.map((item) => item.routineStep);
    const missing = ROUTINE_STEPS.filter((step) => !steps.includes(step));
    const repeated = steps.filter(
      (step, index) => steps.indexOf(step) !== index,
    );

    if (missing.length > 0 || repeated.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['items'],
        message:
          `A routine set needs exactly one product per step. ` +
          (missing.length > 0 ? `Missing: ${missing.join(', ')}. ` : '') +
          (repeated.length > 0 ? `Repeated: ${repeated.join(', ')}.` : ''),
      });
    }

    const gids = update.items.map((item) => item.productGid);
    if (new Set(gids).size !== gids.length) {
      // One product cannot be two steps of the same routine: a product carries
      // a single `custom.routine_step` value, so such a set could never be
      // activated and would only fail later, further from the cause.
      ctx.addIssue({
        code: 'custom',
        path: ['items'],
        message: 'The same product is used for more than one step.',
      });
    }
  });
export type BundleUpdate = z.infer<typeof bundleUpdateSchema>;

/**
 * A product the merchant may put in a routine set.
 *
 * The list is built by reading `custom.routine_step` off active products,
 * because that metafield cannot be used as a `query:` filter — the definition
 * is not admin-filterable, and asking for a filter it cannot serve returns the
 * whole catalog silently. So candidates are grouped here after the fact, which
 * is also why {@link CatalogCandidates} reports how far the search got.
 */
export const catalogCandidateSchema = z.object({
  productGid: z.string().min(1),
  title: z.string(),
  routineStep: routineStepSchema,
  productStatus: z.enum(['ACTIVE', 'ARCHIVED', 'DRAFT']),
});
export type CatalogCandidate = z.infer<typeof catalogCandidateSchema>;

export const catalogCandidatesSchema = z.object({
  candidates: z.array(catalogCandidateSchema),
  /** How many active products were looked at to build this list. */
  scanned: z.number().int().min(0),
  /**
   * Whether the search reached the end of the catalog rather than its page cap.
   *
   * Carried to the browser so the editor can say that its list is partial. A
   * picker that silently shows the first slice of a large catalog is how a
   * merchant concludes a product "cannot be added", and the honest answer —
   * "run the catalog export to see all of them" — needs this flag to be given.
   */
  exhausted: z.boolean(),
});
export type CatalogCandidates = z.infer<typeof catalogCandidatesSchema>;

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
