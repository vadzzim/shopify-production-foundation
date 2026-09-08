import { z } from 'zod';

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
