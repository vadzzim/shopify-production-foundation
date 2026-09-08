import express, { type Router } from 'express';
import type { Prisma, PrismaClient } from '@prisma/client';
import { type JobKind, type WebhookTopic } from '@nordlys/shared';

import { logger as defaultLogger, type Logger } from './logger';
import { acceptDelivery } from './queue';
import { verifyWebhook } from './webhook-verify';

/**
 * The webhook endpoint.
 *
 * Everything Shopify sends this app arrives here, and the whole handler is
 * three steps in a fixed order, each of which rule 3 of `CLAUDE.md` names:
 *
 *   1. verify the HMAC over the raw `Buffer`, before parsing;
 *   2. record the delivery and enqueue its work in one transaction, with the
 *      duplicate decided by a unique index;
 *   3. answer 200 — and only then does any handler run, in the worker.
 *
 * ## "Respond 200 before doing any work"
 *
 * Read literally that could mean answering before the enqueue too. It does not,
 * and the distinction matters. Shopify treats a 200 as *delivered* and will not
 * send the event again; if the response went out before the job row was
 * committed, a crash in that window would lose the event permanently, with
 * nothing anywhere to show it had ever arrived. So the acceptance — one insert
 * and one small transaction, single-digit milliseconds — happens first, and it
 * is what makes the 200 true.
 *
 * What must not happen before the response is *processing*: Admin API calls,
 * external systems, anything whose duration this app does not control. Shopify
 * gives a webhook endpoint a few seconds before it calls the delivery failed
 * and redelivers, so a handler run inline turns one slow dependency into
 * duplicate deliveries — the exact load the idempotency work exists to absorb.
 * This router therefore never calls a handler at all, and a test asserts that:
 * after the 200, the job is still PENDING and nothing has run it.
 */

/**
 * Which job a topic produces.
 *
 * One place, so that "we subscribe to it" and "we do something with it" cannot
 * drift apart. A topic mapped to `null` is one this app acknowledges and
 * deliberately does no work for.
 */
export const JOB_KIND_BY_TOPIC: Record<WebhookTopic, JobKind | null> = {
  'orders/create': 'order.received',
  'products/update': 'product.reconcile',
  'app/uninstalled': 'shop.cleanup',
  // The three mandatory compliance topics share one job kind. They differ in
  // what they ask for, not in how they are handled: each is acknowledged
  // immediately and recorded, and the recorded request is what the 30-day
  // obligation is then discharged against. See ADR-0016.
  'customers/data_request': 'compliance.request',
  'customers/redact': 'compliance.request',
  'shop/redact': 'compliance.request',
};

export interface WebhookRouterDeps {
  prisma: PrismaClient;
  /** The app's client secret. Comes from validated `env`, never a literal. */
  secret: string;
  logger?: Logger;
}

/**
 * The largest body this endpoint will read.
 *
 * An order payload with many line items is the biggest thing Shopify sends
 * here, and it is well under this. The limit exists so that an unauthenticated
 * caller — the signature is checked *after* the body is read, because the
 * signature is over the body — cannot make this process buffer arbitrary
 * memory.
 */
const MAX_BODY_BYTES = '1mb';

export function createWebhookRouter(deps: WebhookRouterDeps): Router {
  const router = express.Router();
  const log = deps.logger ?? defaultLogger;

  router.post(
    '/',
    // `type: '*/*'`, not `'application/json'`. Shopify sends
    // `application/json`, but a request with a missing or altered Content-Type
    // would otherwise fall through this parser with an empty body and be
    // rejected as unsigned — a confusing 401 for what is really a header
    // problem. Taking every content type here means the signature decides.
    express.raw({ type: '*/*', limit: MAX_BODY_BYTES }),
    async (req, res) => {
      // `req.body` is `any` on the Express request type: the type cannot know
      // which parser ran. Narrowing it once here is what lets the rest of this
      // handler — and the type-aware lint rules — treat it as the Buffer
      // `express.raw` actually produced. `verifyWebhook` throws if it is not
      // one, so the narrowing is checked rather than asserted.
      const rawBody: unknown = req.body;

      const verified = verifyWebhook(
        { headers: req.headers, body: rawBody },
        { secret: deps.secret },
      );

      if (!verified.ok) {
        log.warn('Rejected a webhook delivery', {
          status: verified.status,
          reason: verified.reason,
        });
        res.status(verified.status).json({ error: verified.reason });
        return;
      }

      const { topic, shop, webhookId, eventId, apiVersion } = verified.headers;

      // The delivery id is the correlation id. Reusing Shopify's identifier
      // rather than minting our own means a line in these logs and a row in the
      // store's webhook delivery log in the Partner dashboard can be matched
      // without a lookup table.
      const correlationId = webhookId;
      const requestLog = log.child({ correlationId, shop, topic });

      let body: unknown;

      try {
        // Past `verifyWebhook`, so this is a Buffer — that function throws
        // otherwise, and the throw is covered by a test.
        body = JSON.parse((rawBody as Buffer).toString('utf8'));
      } catch {
        // Signed by Shopify and not JSON. Not something a retry fixes, so 400
        // rather than 500 — a 500 would have Shopify redeliver it five times.
        requestLog.error('A verified delivery had a body that is not JSON');
        res.status(400).json({ error: 'body is not valid JSON' });
        return;
      }

      const kind = JOB_KIND_BY_TOPIC[topic];

      const result = await acceptDelivery(deps.prisma, {
        webhookId,
        ...(eventId ? { eventId } : {}),
        shop,
        topic,
        apiVersion,
        jobs: kind
          ? [
              {
                shop,
                kind,
                // The cast is the one place this file asserts something the
                // compiler cannot see: `body` came out of `JSON.parse` two
                // statements ago, so it is JSON by construction, but its static
                // type is `unknown` because a parser cannot promise more.
                payload: { topic, body } as Prisma.InputJsonValue,
                correlationId,
              },
            ]
          : [],
      });

      if (!result.accepted) {
        // The expected outcome of a redelivery, not an error: Shopify resends
        // when it does not get a timely 200, and it makes no exactly-once
        // promise when it does. 200 again, no second job.
        requestLog.info('Duplicate delivery ignored');
        res.status(200).json({ status: 'duplicate' });
        return;
      }

      requestLog.info('Delivery accepted', { jobIds: result.jobIds });
      res.status(200).json({ status: 'accepted', jobIds: result.jobIds });
    },
  );

  return router;
}
