import type { PrismaClient } from '@prisma/client';
import {
  inventoryPushPayloadSchema,
  webhookJobPayloadSchema,
  type JobKind,
} from '@nordlys/shared';

import type { AdminGraphql } from './admin-graphql';
import { unwrap } from './admin-graphql';
import { PRODUCT_ROUTINE_STEP } from './graphql-documents';
import { pushInventoryOnHand } from './inventory';
import type { Logger } from './logger';
import type { QueueJob } from './queue';
import { fromPrismaRoutineStep } from './bundles';

/**
 * What the worker actually runs.
 *
 * Handlers are ordinary async functions with their dependencies passed in, for
 * the same reason the API router takes its dependencies as arguments: it is
 * what makes the failure paths testable. Half of what matters here — a product
 * deleted between the webhook and the job, an order naming a bundle that is not
 * ours, an inventory write Shopify refuses — is invisible to a manual
 * click-through and trivial to assert against a fake.
 *
 * Every handler must be safe to run twice. The delivery-level deduplication in
 * `queue.ts` stops the same *delivery* producing two jobs; it says nothing
 * about one job being retried after an ambiguous failure, which is exactly what
 * an at-least-once queue does. So each handler is written to converge on the
 * same end state rather than to apply a change.
 */

export interface HandlerContext {
  job: QueueJob;
  prisma: PrismaClient;
  /**
   * An Admin API client for this shop, on the **offline** token.
   *
   * It has to be offline. A job runs when the queue gets to it, which is
   * routinely after the staff member who triggered it has closed the tab and
   * their online token has expired with their admin session. It is also a
   * function rather than a value so that a handler which needs no Admin API
   * call — `shop.cleanup` runs *after* the token has been revoked — never
   * causes one to be loaded.
   */
  graphqlFor: (shop: string) => Promise<AdminGraphql>;
  log: Logger;
}

export type JobHandler = (context: HandlerContext) => Promise<void>;

/**
 * Raised when a job can never succeed, however many times it is retried.
 *
 * A malformed payload, or a topic whose data has already been deleted, does not
 * get better on the fourth attempt — retrying it just spends four slots and
 * delays the sync log telling anyone. The worker sends these straight to the
 * dead-letter state.
 */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

/** Line item properties are name/value pairs in the webhook payload. */
interface OrderLineItem {
  id?: number;
  title?: string;
  properties?: { name?: string; value?: string }[] | null;
}

interface OrderPayload {
  id?: number;
  name?: string;
  line_items?: OrderLineItem[] | null;
}

function parseWebhookPayload(job: QueueJob): { topic: string; body: unknown } {
  const parsed = webhookJobPayloadSchema.safeParse(job.payload);

  if (!parsed.success) {
    throw new PermanentJobError(
      `Job payload does not match the webhook shape: ${parsed.error.message}`,
    );
  }

  return { topic: parsed.data.topic, body: parsed.data.body };
}

/**
 * `orders/create` — check the order against the bundles this app owns.
 *
 * The theme's bundle-builder adds every line item of a routine set to the cart
 * with a `_bundle_id` line item property (ADR-0012). That property is the only
 * link between an order in Shopify and a bundle row here, and it is written by
 * the storefront, which means it can name a bundle that has since been deleted
 * or that belongs to another shop.
 *
 * So this handler resolves the ids and reports the ones it cannot: an order
 * referencing a bundle we do not have is drift between the theme and the app —
 * usually a theme still deployed after the bundle was removed — and it is the
 * kind of thing that is obvious in a log line and invisible in a revenue chart.
 * It writes nothing, which is what makes it trivially safe to re-run.
 */
const handleOrderReceived: JobHandler = async ({ job, prisma, log }) => {
  const { body } = parseWebhookPayload(job);
  const order = body as OrderPayload;

  const bundleIds = new Set<string>();

  for (const item of order.line_items ?? []) {
    for (const property of item.properties ?? []) {
      if (property.name === '_bundle_id' && property.value) {
        bundleIds.add(property.value);
      }
    }
  }

  if (bundleIds.size === 0) {
    log.debug('Order contains no bundle line items', {
      orderName: order.name,
    });
    return;
  }

  const known = await prisma.bundle.findMany({
    // Scoped to the shop as well as the id. One deployment serves many stores,
    // and an id looked up without its shop is a cross-tenant read.
    where: { shop: job.shop, id: { in: [...bundleIds] } },
    select: { id: true },
  });

  const knownIds = new Set(known.map((bundle) => bundle.id));
  const unknown = [...bundleIds].filter((id) => !knownIds.has(id));

  if (unknown.length > 0) {
    log.warn('Order references bundles this app does not have', {
      orderName: order.name,
      unknownBundleIds: unknown,
    });
  }

  log.info('Order recorded', {
    orderName: order.name,
    bundleIds: [...knownIds],
  });
};

interface ProductRoutineStepResponse {
  product: {
    id: string;
    title: string;
    status: 'ACTIVE' | 'ARCHIVED' | 'DRAFT';
    routineStep: { value: string } | null;
  } | null;
}

/**
 * `products/update` — keep bundles honest about the products in them.
 *
 * A routine set holds one product per step, and which step a product belongs to
 * is the merchant's `custom.routine_step` metafield, edited in the admin where
 * this app cannot see it happen. Three edits break a bundle: changing the step,
 * archiving the product, and deleting it. In all three the bundle still looks
 * fine in our database and renders a set the storefront cannot fulfil.
 *
 * The response is to demote the affected bundles from ACTIVE to DRAFT. Not to
 * repair them: a bundle whose "treat" slot now holds a cleanser cannot be fixed
 * without deciding what the merchant meant, and the unique index on
 * `[bundleId, routineStep]` means a naive move could collide with the product
 * already in the target slot. Demoting stops the storefront offering a broken
 * set and leaves the decision where it belongs, with a log line saying why.
 *
 * Re-running is safe: a bundle already DRAFT is left alone, and the check is a
 * comparison against live Shopify state rather than a step in a sequence.
 */
const handleProductReconcile: JobHandler = async ({
  job,
  prisma,
  graphqlFor,
  log,
}) => {
  const { body } = parseWebhookPayload(job);
  const product = body as { id?: number; admin_graphql_api_id?: string };

  const productGid =
    product.admin_graphql_api_id ??
    (product.id === undefined
      ? undefined
      : `gid://shopify/Product/${String(product.id)}`);

  if (!productGid) {
    throw new PermanentJobError(
      'The products/update payload carried neither admin_graphql_api_id nor id.',
    );
  }

  const affected = await prisma.bundleItem.findMany({
    where: { productGid, bundle: { shop: job.shop, status: 'ACTIVE' } },
    select: { bundleId: true, routineStep: true },
  });

  if (affected.length === 0) {
    log.debug('No active bundle uses this product', { productGid });
    return;
  }

  // The payload does carry metafields on some topics, but only those the
  // subscription asked to include, and the app-specific subscription in
  // shopify.app.toml asks for none. Reading the step back from the Admin API is
  // one call and is authoritative; trusting a field that may not be there is a
  // reconciliation that quietly does nothing.
  const graphql = await graphqlFor(job.shop);
  const data = unwrap<ProductRoutineStepResponse>(
    'product',
    await graphql<ProductRoutineStepResponse>(PRODUCT_ROUTINE_STEP, {
      id: productGid,
    }),
  );

  const live = data.product;
  const liveStep = live?.routineStep?.value ?? null;

  const broken = affected.filter((item) => {
    // Deleted, or no longer visible to this token.
    if (!live) return true;
    if (live.status !== 'ACTIVE') return true;
    return liveStep !== fromPrismaRoutineStep(item.routineStep);
  });

  if (broken.length === 0) {
    log.debug('Product still matches every bundle that uses it', {
      productGid,
    });
    return;
  }

  const bundleIds = [...new Set(broken.map((item) => item.bundleId))];

  const demoted = await prisma.bundle.updateMany({
    where: { id: { in: bundleIds }, shop: job.shop, status: 'ACTIVE' },
    data: { status: 'DRAFT' },
  });

  log.warn('Demoted bundles to draft after a product changed under them', {
    productGid,
    productStatus: live?.status ?? 'deleted',
    liveRoutineStep: liveStep,
    bundleIds,
    demoted: demoted.count,
  });
};

/**
 * `app/uninstalled` — drop what is now unusable.
 *
 * Sessions go, and they go first: the moment the app is uninstalled every token
 * for that shop is revoked, so what is left in the table is a set of
 * credentials that authenticate nothing and would have any background task
 * failing against a 401 forever.
 *
 * Bundles stay. Uninstalling is not the same as asking to be forgotten — a
 * merchant who reinstalls next week expects their routine sets to still be
 * there, and Shopify's own deletion obligation arrives separately as
 * `shop/redact`, 48 hours later, which is what this app treats as the
 * instruction to erase. Deleting on uninstall would make that webhook
 * meaningless and lose data for the commonest reason an app is removed, which
 * is a merchant trying something.
 *
 * No Admin API call happens here, and none can: the token this handler would
 * have used is the one that was just revoked.
 */
const handleShopCleanup: JobHandler = async ({ job, prisma, log }) => {
  const sessions = await prisma.session.deleteMany({
    where: { shop: job.shop },
  });

  log.info('App uninstalled: cleared sessions', {
    sessionsDeleted: sessions.count,
  });
};

interface CompliancePayload {
  shop_domain?: string;
  customer?: { id?: number; email?: string };
  orders_requested?: number[];
  data_request?: { id?: number };
}

/**
 * The three mandatory compliance topics.
 *
 * What this app stores decides what each of them means, so it is worth saying
 * plainly: **there is no customer personal data in this database.** The schema
 * holds OAuth sessions (staff, not customers), bundle definitions, webhook
 * delivery ids and job rows. Nothing keyed to a customer, no addresses, no
 * order contents beyond the ids a webhook mentioned in passing.
 *
 * That makes `customers/data_request` and `customers/redact` genuine no-ops
 * rather than unimplemented ones — and the difference is only defensible if it
 * stays true, which is why a test asserts the set of tables that may hold
 * customer data is empty. Add such a table and that test fails, here, rather
 * than during an app review.
 *
 * `shop/redact` is different: it is the instruction to erase, and it is the one
 * that deletes. It arrives 48 hours after uninstall, which is why the uninstall
 * handler above deliberately leaves the bundles alone.
 */
const handleComplianceRequest: JobHandler = async ({ job, prisma, log }) => {
  const { topic, body } = parseWebhookPayload(job);
  const payload = body as CompliancePayload;

  if (topic === 'customers/data_request') {
    log.info('Customer data request: this app stores no customer data', {
      customerId: payload.customer?.id,
      dataRequestId: payload.data_request?.id,
      ordersRequested: payload.orders_requested?.length ?? 0,
    });
    return;
  }

  if (topic === 'customers/redact') {
    log.info('Customer redaction request: nothing stored to redact', {
      customerId: payload.customer?.id,
    });
    return;
  }

  if (topic === 'shop/redact') {
    // Order matters only for readability; all three are scoped to this shop and
    // BundleItem cascades from Bundle.
    const bundles = await prisma.bundle.deleteMany({ where: { shop: job.shop } });
    const sessions = await prisma.session.deleteMany({
      where: { shop: job.shop },
    });
    const deliveries = await prisma.webhookDelivery.deleteMany({
      where: { shop: job.shop },
    });

    log.info('Shop redaction request completed', {
      bundlesDeleted: bundles.count,
      sessionsDeleted: sessions.count,
      deliveriesDeleted: deliveries.count,
    });
    return;
  }

  throw new PermanentJobError(`Not a compliance topic: ${topic}`);
};

/**
 * Push an on-hand quantity to Shopify.
 *
 * The idempotency key Shopify requires on this mutation is the **job id**, so a
 * retry of this row re-sends the same key and Shopify applies the write once.
 * See `inventory.ts` for why that, and the absolute quantity, are what make an
 * at-least-once queue safe to point at stock levels.
 */
const handleInventoryPush: JobHandler = async ({ job, graphqlFor, log }) => {
  const parsed = inventoryPushPayloadSchema.safeParse(job.payload);

  if (!parsed.success) {
    throw new PermanentJobError(
      `Job payload does not match the inventory push shape: ${parsed.error.message}`,
    );
  }

  const graphql = await graphqlFor(job.shop);
  const result = await pushInventoryOnHand(graphql, parsed.data, {
    idempotencyKey: job.id,
  });

  log.info('Inventory pushed', {
    inventoryItemId: parsed.data.inventoryItemId,
    locationId: parsed.data.locationId,
    quantity: parsed.data.quantity,
    changes: result.changes,
  });
};

export const JOB_HANDLERS: Record<JobKind, JobHandler> = {
  'order.received': handleOrderReceived,
  'product.reconcile': handleProductReconcile,
  'shop.cleanup': handleShopCleanup,
  'compliance.request': handleComplianceRequest,
  'inventory.push': handleInventoryPush,
};
