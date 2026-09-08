import { createHmac, timingSafeEqual } from 'node:crypto';

import { webhookTopicSchema, type WebhookTopic } from '@nordlys/shared';

/**
 * Webhook authenticity, checked the way rule 3 of `CLAUDE.md` requires: an
 * HMAC-SHA256 over the **raw request body as a `Buffer`**, compared with
 * `crypto.timingSafeEqual`, before anything parses the body as JSON.
 *
 * ## Why this is written rather than delegated
 *
 * `@shopify/shopify-app-express` ships `shopify.processWebhooks()`, which
 * verifies the HMAC itself, and ADR-0002 is built on the principle that vendor
 * authentication code should not be reimplemented. That principle was weighed
 * here and lost on three specific points, each read out of the installed
 * sources rather than assumed. The full argument is ADR-0016; the short form:
 *
 * 1. **It never sees a Buffer.** `processWebhooks` mounts `express.text()`
 *    over every content type, so the body reaches verification as a
 *    `string` decoded through a charset. Every byte that is not valid UTF-8
 *    becomes U+FFFD on the way in, and the HMAC is then computed over different
 *    bytes than Shopify signed. Shopify sends UTF-8, so this works — until a
 *    payload carries something that is not, at which point a valid delivery
 *    fails verification and there is nothing in the logs to explain it.
 *
 * 2. **The comparison is a hand-written loop.** The SDK's `safeCompare`
 *    JSON-stringifies both sides and XORs them in a JavaScript `for` loop.
 *    Its length check makes it constant-time in intent, but a JIT-compiled
 *    userland loop carries no such guarantee from the engine. `crypto.
 *    timingSafeEqual` is the primitive that does, and rule 3 names it.
 *
 * 3. **It cannot answer before it works.** `shopify.api.webhooks.process()`
 *    awaits every handler and only then writes the response. Rule 3 requires
 *    the opposite order, and for a reason that shows up under load: a handler
 *    slower than Shopify's delivery timeout produces a redelivery, which
 *    produces another slow handler.
 *
 * The cost of writing it: this file is now ours to keep correct, and a change
 * in how Shopify signs deliveries lands on us rather than on a `pnpm update`.
 * That is a real cost, and it is why the verification is fifty lines with a
 * test for each branch rather than spread through the receiver.
 */

/**
 * Header names, lower-cased.
 *
 * Node lower-cases incoming header names, and HTTP header names are
 * case-insensitive besides. Confirmed against Shopify's webhook documentation
 * for 2026-07 rather than copied from memory: the SDK's `ShopifyHeader` enum
 * spells them in title case, which is the same header.
 */
export const WEBHOOK_HEADERS = {
  hmac: 'x-shopify-hmac-sha256',
  topic: 'x-shopify-topic',
  shop: 'x-shopify-shop-domain',
  apiVersion: 'x-shopify-api-version',
  /** Unique per delivery attempt. The idempotency key (rule 10). */
  webhookId: 'x-shopify-webhook-id',
  /** Shared by all deliveries caused by one merchant action. */
  eventId: 'x-shopify-event-id',
  triggeredAt: 'x-shopify-triggered-at',
} as const;

export interface WebhookHeaders {
  topic: WebhookTopic;
  shop: string;
  apiVersion: string;
  webhookId: string;
  eventId?: string;
  triggeredAt?: string;
}

export type VerificationFailure =
  /**
   * Answered 401. Shopify's app review requirement for the mandatory
   * compliance topics is explicit: a delivery with an invalid HMAC header must
   * be answered 401, not 200 and not 500.
   */
  | { ok: false; status: 401; reason: string }
  /** Answered 400: the request is malformed rather than unauthorised. */
  | { ok: false; status: 400; reason: string };

export type VerificationResult =
  | { ok: true; headers: WebhookHeaders }
  | VerificationFailure;

/** What `verifyWebhook` needs from a request, so a test needs no server. */
export interface RawWebhookRequest {
  /** Lower-cased header names, as Node delivers them. */
  headers: Record<string, string | string[] | undefined>;
  /** The unparsed body. A `Buffer`, or verification cannot be trusted. */
  body: unknown;
}

function headerValue(
  headers: RawWebhookRequest['headers'],
  name: string,
): string | undefined {
  const value = headers[name];
  // Node folds a repeated header into an array. A webhook has no repeated
  // headers, so an array here means something upstream is rewriting the
  // request; refusing is safer than picking one.
  if (typeof value !== 'string') return undefined;
  return value.length > 0 ? value : undefined;
}

/**
 * Constant-time comparison of the received signature against ours.
 *
 * `timingSafeEqual` throws when the two buffers differ in length, so the length
 * is checked first — and checking it leaks only the length of the attacker's
 * own input, which they already know. Decoding the header as base64 rather than
 * comparing the base64 text has the same effect and is what Shopify documents
 * the header to be.
 */
function signaturesMatch(received: string, expected: Buffer): boolean {
  let receivedBytes: Buffer;

  try {
    receivedBytes = Buffer.from(received, 'base64');
  } catch {
    return false;
  }

  if (receivedBytes.length !== expected.length) return false;

  return timingSafeEqual(receivedBytes, expected);
}

export interface VerifyWebhookOptions {
  /** The app's client secret — the HMAC key. From `env`, never a literal. */
  secret: string;
}

/**
 * Verify a delivery and pull out the headers the rest of the pipeline needs.
 *
 * The order of the checks is part of the contract. The signature is verified
 * before any other header is read and before the body is parsed, so nothing
 * downstream ever acts on the contents of an unauthenticated request — not even
 * to decide which topic it claims to be.
 */
export function verifyWebhook(
  request: RawWebhookRequest,
  options: VerifyWebhookOptions,
): VerificationResult {
  const { body, headers } = request;

  if (body === undefined) {
    // A request that carried no body at all: no `Content-Length` and no
    // `Transfer-Encoding`, so `express.raw` had nothing to read and never set
    // `req.body`. That is a malformed request from an unauthenticated caller,
    // not a wiring mistake — and it must not reach the branch below, which
    // throws. It did, and the endpoint answered 500 to `curl -X POST` with no
    // data; found by sending one, not by any test or type.
    return { ok: false, status: 400, reason: 'no body' };
  }

  if (!Buffer.isBuffer(body)) {
    // Anything else that is not a Buffer means the route was mounted without
    // `express.raw()`, or behind `express.json()`, and the body has already
    // been through a parser. Verifying a re-serialised body would pass for the
    // wrong reason — `JSON.stringify(JSON.parse(x))` is not `x` — so this is
    // loud rather than a rejected delivery.
    throw new Error(
      'The webhook body is not a Buffer. Mount this route with ' +
        'express.raw({ type: "application/json" }) before express.json().',
    );
  }

  const received = headerValue(headers, WEBHOOK_HEADERS.hmac);

  if (!received) {
    return { ok: false, status: 401, reason: 'missing HMAC header' };
  }

  if (body.length === 0) {
    return { ok: false, status: 400, reason: 'empty body' };
  }

  const expected = createHmac('sha256', options.secret).update(body).digest();

  if (!signaturesMatch(received, expected)) {
    return { ok: false, status: 401, reason: 'HMAC mismatch' };
  }

  // Only now, with the request proven to come from Shopify, is anything else
  // about it read.
  const topic = headerValue(headers, WEBHOOK_HEADERS.topic);
  const shop = headerValue(headers, WEBHOOK_HEADERS.shop);
  const apiVersion = headerValue(headers, WEBHOOK_HEADERS.apiVersion);
  const webhookId = headerValue(headers, WEBHOOK_HEADERS.webhookId);

  const missing = [
    ...(topic ? [] : [WEBHOOK_HEADERS.topic]),
    ...(shop ? [] : [WEBHOOK_HEADERS.shop]),
    ...(apiVersion ? [] : [WEBHOOK_HEADERS.apiVersion]),
    ...(webhookId ? [] : [WEBHOOK_HEADERS.webhookId]),
  ];

  if (!topic || !shop || !apiVersion || !webhookId) {
    return {
      ok: false,
      status: 400,
      reason: `missing required headers: ${missing.join(', ')}`,
    };
  }

  const known = webhookTopicSchema.safeParse(topic);

  if (!known.success) {
    // A signed, well-formed delivery for a topic nothing here handles. That is
    // a subscription in `shopify.app.toml` with no code behind it, so it is a
    // 400 with the topic named rather than a silent 200 that would let the
    // mismatch sit undiscovered.
    return { ok: false, status: 400, reason: `unhandled topic: ${topic}` };
  }

  return {
    ok: true,
    headers: {
      topic: known.data,
      shop,
      apiVersion,
      webhookId,
      ...(headerValue(headers, WEBHOOK_HEADERS.eventId)
        ? { eventId: headerValue(headers, WEBHOOK_HEADERS.eventId) }
        : {}),
      ...(headerValue(headers, WEBHOOK_HEADERS.triggeredAt)
        ? { triggeredAt: headerValue(headers, WEBHOOK_HEADERS.triggeredAt) }
        : {}),
    },
  };
}

/**
 * The signature Shopify would send for this body. Test helper, exported so the
 * receiver's tests can sign a request the same way the platform does.
 */
export function signWebhookBody(body: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}
