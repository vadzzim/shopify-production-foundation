import { z } from 'zod';

import { ROUTINE_STEPS, routineStepSchema } from './bundle';

/**
 * The queue's vocabulary, shared by the server and the sync-log screen.
 *
 * A job kind is a contract between the thing that enqueues and the thing that
 * runs, and the payload is stored as `jsonb` — so nothing about it is checked
 * by the database or by the compiler once it has been written. Parsing the
 * payload with the schema below at the start of each handler is what turns "the
 * row said it was an inventory push" into a typed value: a job enqueued by an
 * older deploy, or by hand in Prisma Studio, fails as a validation error with
 * the field named rather than as `undefined.quantity` three calls deeper.
 */

/**
 * Webhook topics this app subscribes to.
 *
 * The strings are Shopify's, lower-case with a slash, exactly as they appear in
 * `X-Shopify-Topic` and in `[[webhooks.subscriptions]]` in `shopify.app.toml`.
 * The two lists have to agree — a topic subscribed to but not listed here is a
 * delivery the receiver rejects, and one listed here but not subscribed to is
 * dead code — so a test asserts the TOML against this constant.
 */
export const WEBHOOK_TOPICS = [
  'orders/create',
  'products/update',
  'app/uninstalled',
] as const;

/**
 * The three mandatory compliance topics.
 *
 * Kept apart from the list above because Shopify treats them differently:
 * they are declared under `compliance_topics` rather than `topics`, they cannot
 * be created through the Admin API at all, and the requirement attached to them
 * is a legal one — a 200 to acknowledge receipt, and the action completed
 * within 30 days.
 */
export const COMPLIANCE_TOPICS = [
  'customers/data_request',
  'customers/redact',
  'shop/redact',
] as const;

export const webhookTopicSchema = z.enum([
  ...WEBHOOK_TOPICS,
  ...COMPLIANCE_TOPICS,
]);
export type WebhookTopic = z.infer<typeof webhookTopicSchema>;

export const JOB_KINDS = [
  'order.received',
  'product.reconcile',
  'shop.cleanup',
  'compliance.request',
  'inventory.push',
  'catalog.export',
] as const;

export const jobKindSchema = z.enum(JOB_KINDS);
export type JobKind = z.infer<typeof jobKindSchema>;

export const jobStatusSchema = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'dead',
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

/**
 * The payload of every job that a webhook produces: the delivery's body,
 * unparsed beyond JSON.
 *
 * It is deliberately not narrowed per topic. The handler reads the two or three
 * fields it needs and treats the rest as opaque, because Shopify adds fields to
 * webhook payloads within a version and a schema that rejected unknown keys
 * would turn that into an outage. What is *required* is checked by each
 * handler, not here.
 */
export const webhookJobPayloadSchema = z.object({
  topic: webhookTopicSchema,
  /** The delivery body, already parsed from JSON by the receiver. */
  body: z.unknown(),
});
export type WebhookJobPayload = z.infer<typeof webhookJobPayloadSchema>;

/**
 * An inventory level to push to Shopify.
 *
 * Stock does not live on the variant. It lives on the pair
 * InventoryItem × Location: one product variant has one inventory item, and
 * that item has a separate quantity at every location the shop stocks it in.
 * Writing "set variant X to 40" is not expressible, and an integration that
 * thinks in variants silently writes to whichever location it happened to pick
 * — which is right until the merchant opens a second warehouse.
 */
export const inventoryPushPayloadSchema = z.object({
  inventoryItemId: z.string().startsWith('gid://shopify/InventoryItem/'),
  locationId: z.string().startsWith('gid://shopify/Location/'),
  /** On-hand units. Absolute, not a delta — see ADR-0017. */
  quantity: z.number().int().min(0),
  /**
   * Where this number came from, for the adjustment group's audit trail in the
   * Shopify admin. A URI rather than free text because that is what Shopify
   * stores it as.
   */
  referenceDocumentUri: z.url().optional(),
});
export type InventoryPushPayload = z.infer<typeof inventoryPushPayloadSchema>;

/**
 * The state a catalog export carries between attempts.
 *
 * `bulkOperationId` is empty on the first attempt and written to the job row as
 * soon as Shopify has accepted the operation. That is not bookkeeping: starting
 * a bulk operation is **not** idempotent, and this queue is at-least-once, so a
 * retry that re-ran the mutation would start a second export of the same
 * catalog. Recording the id is what lets a retry resume polling the operation
 * the previous attempt started instead of duplicating it.
 */
export const catalogExportPayloadSchema = z.object({
  bulkOperationId: z
    .string()
    .startsWith('gid://shopify/BulkOperation/')
    .optional(),
});
export type CatalogExportPayload = z.infer<typeof catalogExportPayloadSchema>;

/**
 * What a finished catalog export says about the store.
 *
 * It is a **dated document, not a cache.** Nothing renders live catalog state
 * from it — product titles on the bundle screen are still read from the Admin
 * API on every request (ADR-0007) — and the merchant reads it as "here is what
 * your catalog looked like at `completedAt`". That distinction is what makes
 * the sample below acceptable: a snapshot may name products, a cache may not.
 */
export const catalogExportReportSchema = z.object({
  bulkOperationId: z.string().min(1),
  /** Products the operation actually wrote to its result file. */
  objectCount: z.number().int().min(0),
  /** How many active products carry each step. */
  byStep: z.record(routineStepSchema, z.number().int().min(0)),
  /** Active products with no `custom.routine_step` value at all. */
  withoutStep: z.number().int().min(0),
  /**
   * Values found in the metafield that are not one of {@link ROUTINE_STEPS}.
   *
   * Reported rather than ignored: a product set to "moisturise" instead of
   * "moisturize" is invisible to every other screen in this app, and the
   * merchant has no way to discover it except by being told.
   */
  unrecognisedSteps: z.array(
    z.object({ value: z.string(), count: z.number().int().min(1) }),
  ),
  /** A few of the products with no step, so the report is actionable. */
  sampleWithoutStep: z.array(
    z.object({ productGid: z.string().min(1), title: z.string() }),
  ),
  completedAt: z.iso.datetime(),
});
export type CatalogExportReport = z.infer<typeof catalogExportReportSchema>;

/** Every routine step is a key of the report's `byStep`, including zeroes. */
export function emptyStepCounts(): Record<(typeof ROUTINE_STEPS)[number], number> {
  return Object.fromEntries(ROUTINE_STEPS.map((step) => [step, 0])) as Record<
    (typeof ROUTINE_STEPS)[number],
    number
  >;
}

/**
 * One row of the sync log, as the screen renders it.
 *
 * `lastError` is carried through to the browser on purpose. A merchant looking
 * at a failed sync needs to know whether Shopify refused the change or the
 * external system was down, and "something went wrong" answers neither.
 */
export const jobSummarySchema = z.object({
  id: z.string().min(1),
  kind: jobKindSchema,
  status: jobStatusSchema,
  attempts: z.number().int().min(0),
  maxAttempts: z.number().int().min(1),
  runAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  correlationId: z.string().min(1),
  topic: webhookTopicSchema.nullable(),
});
export type JobSummary = z.infer<typeof jobSummarySchema>;

export const jobListResponseSchema = z.object({
  jobs: z.array(jobSummarySchema),
});
export type JobListResponse = z.infer<typeof jobListResponseSchema>;

/**
 * The catalog export as one screen needs it: the most recent run, and the
 * report if that run produced one.
 *
 * Both are nullable, and they are nullable independently. A store that has
 * never exported has neither; a running export has a job and no report; a
 * failed one has a job, no report, and a reason in `job.lastError`.
 */
export const catalogExportStatusSchema = z.object({
  job: jobSummarySchema.nullable(),
  report: catalogExportReportSchema.nullable(),
});
export type CatalogExportStatus = z.infer<typeof catalogExportStatusSchema>;
