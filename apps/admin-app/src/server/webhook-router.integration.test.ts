import type { PrismaClient } from '@prisma/client';
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { JOB_KIND_BY_TOPIC, createWebhookRouter } from './webhook-router';
import { signWebhookBody } from './webhook-verify';
import {
  cleanTestData,
  createTestPrisma,
  hasDatabase,
  only,
  testShop,
} from './test-database';

/**
 * The receiver, end to end over real HTTP against a real database.
 *
 * The unit tests in `webhook-verify.test.ts` cover the signature arithmetic.
 * What this file exists for is the wiring around it, which is where the
 * mistakes with the worst symptoms live: a body that reached the verifier
 * already parsed, an endpoint that answers before the row is committed, a
 * redelivery that produces a second job. None of those is visible in a unit
 * test of either half.
 */

const SECRET = 'shpss_test_secret_do_not_use';
const SHOP = testShop('receiver');

/**
 * Post a body exactly as written, signed exactly as Shopify signs it.
 *
 * The body is a **string**. Superagent re-encodes the alternatives — a `Buffer`
 * sent as `application/json` arrives as `{"type":"Buffer","data":[...]}` — and
 * then the bytes on the wire are not the bytes that were signed, which is a 401
 * that says nothing about the code under test. That is not a hypothetical: it
 * is how every test in this file failed the first time it ran.
 */
function postRaw(
  app: express.Express,
  raw: string,
  overrides: Record<string, string> = {},
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-shopify-hmac-sha256': signWebhookBody(Buffer.from(raw, 'utf8'), SECRET),
    'x-shopify-topic': 'orders/create',
    'x-shopify-shop-domain': SHOP,
    'x-shopify-api-version': '2026-07',
    'x-shopify-webhook-id': 'delivery-abc',
    ...overrides,
  };

  return request(app).post('/api/webhooks').set(headers).send(raw);
}

function post(
  app: express.Express,
  body: unknown,
  overrides: Record<string, string> = {},
) {
  return postRaw(app, JSON.stringify(body), overrides);
}

describe.skipIf(!hasDatabase)('POST /api/webhooks', () => {
  let prisma: PrismaClient;
  let app: express.Express;

  beforeAll(() => {
    prisma = createTestPrisma();
    app = express();
    // Mounted as `app.ts` mounts it, and — importantly — with `express.json()`
    // installed after it on a sibling path. That is the arrangement that would
    // break verification if the raw parser were not scoped to this route.
    app.use('/api/webhooks', createWebhookRouter({ prisma, secret: SECRET }));
    app.use('/api', express.json(), (_req, res) => {
      res.json({ ok: true });
    });
  });

  afterEach(async () => {
    await cleanTestData(prisma, SHOP);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('accepts a signed delivery and queues exactly one job', async () => {
    const response = await post(app, { id: 1, name: '#1001' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'accepted' });

    const job = only(await prisma.job.findMany({ where: { shop: SHOP } }));
    expect(job.kind).toBe('order.received');
    // The delivery id doubles as the correlation id, so a log line and
    // Shopify's own delivery record can be matched without a lookup table.
    expect(job.correlationId).toBe('delivery-abc');
    expect(job.webhookId).toBe('delivery-abc');
  });

  it('creates no second job when Shopify redelivers', async () => {
    // The completion criterion of this phase, over HTTP: the same delivery
    // twice, one job.
    const first = await post(app, { id: 1, name: '#1001' });
    const second = await post(app, { id: 1, name: '#1001' });

    expect(first.status).toBe(200);
    // 200 again, not 409: from Shopify's side the delivery succeeded, and any
    // other status would have it keep retrying.
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ status: 'duplicate' });

    expect(await prisma.job.count({ where: { shop: SHOP } })).toBe(1);
  });

  it('creates no second job when the retry overlaps the original', async () => {
    const [a, b] = await Promise.all([
      post(app, { id: 1 }),
      post(app, { id: 1 }),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await prisma.job.count({ where: { shop: SHOP } })).toBe(1);
  });

  it('answers before anything has run the job', async () => {
    // Rule 3, asserted rather than asserted-about. At the moment the response
    // was written the job exists, is PENDING, has never been attempted and has
    // no result — which is only possible if no handler had run.
    const response = await post(app, { id: 1 });

    expect(response.status).toBe(200);

    const job = await prisma.job.findFirstOrThrow({ where: { shop: SHOP } });
    expect(job.status).toBe('PENDING');
    expect(job.attempts).toBe(0);
    expect(job.finishedAt).toBeNull();
    expect(job.lockedBy).toBeNull();
  });

  it('refuses a forged signature with 401 and queues nothing', async () => {
    const response = await post(
      app,
      { id: 1 },
      {
        'x-shopify-hmac-sha256':
          'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      },
    );

    expect(response.status).toBe(401);
    expect(await prisma.job.count({ where: { shop: SHOP } })).toBe(0);
    expect(await prisma.webhookDelivery.count({ where: { shop: SHOP } })).toBe(
      0,
    );
  });

  it('refuses a body altered after it was signed', async () => {
    // A genuine signature for a different body: the replay case.
    const signed = JSON.stringify({ id: 1 });
    const altered = JSON.stringify({ id: 1, total: '0.00' });

    const response = await request(app)
      .post('/api/webhooks')
      .set({
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': signWebhookBody(
          Buffer.from(signed, 'utf8'),
          SECRET,
        ),
        'x-shopify-topic': 'orders/create',
        'x-shopify-shop-domain': SHOP,
        'x-shopify-api-version': '2026-07',
        'x-shopify-webhook-id': 'delivery-tampered',
      })
      .send(altered);

    expect(response.status).toBe(401);
    expect(await prisma.job.count({ where: { shop: SHOP } })).toBe(0);
  });

  it('accepts a compliance topic and queues the compliance job', async () => {
    const response = await post(
      app,
      { shop_domain: SHOP, customer: { id: 1 } },
      {
        'x-shopify-topic': 'customers/redact',
        'x-shopify-webhook-id': 'delivery-redact',
      },
    );

    expect(response.status).toBe(200);

    const job = await prisma.job.findFirstOrThrow({ where: { shop: SHOP } });
    expect(job.kind).toBe('compliance.request');
  });

  it('rejects a signed delivery for a topic with no handler', async () => {
    const response = await post(
      app,
      { id: 1 },
      {
        'x-shopify-topic': 'carts/update',
        'x-shopify-webhook-id': 'delivery-carts',
      },
    );

    // Better than a silent 200: a subscription in shopify.app.toml with no code
    // behind it should be noticed, and this is the only place it can be.
    expect(response.status).toBe(400);
    expect(await prisma.job.count({ where: { shop: SHOP } })).toBe(0);
  });

  it('answers 400, not 500, to a POST with no body', async () => {
    // An unauthenticated caller must not be able to reach a throw. This one
    // could: `express.raw` skips a request with no Content-Length, and the
    // verifier's wiring guard fired on the resulting undefined body.
    const response = await request(app).post('/api/webhooks');

    expect(response.status).toBe(400);
  });

  it('answers 400 for a signed body that is not JSON', async () => {
    const response = await postRaw(app, 'not json at all', {
      'x-shopify-webhook-id': 'delivery-garbage',
    });

    // 400 and not 500: a 500 would have Shopify redeliver something no retry
    // can fix.
    expect(response.status).toBe(400);
  });

  it('verifies against the bytes on the wire, not a re-serialised body', async () => {
    // Shopify's JSON is not what `JSON.stringify` would produce from the same
    // value: key order, whitespace and unicode escaping all differ. A receiver
    // that parsed first and re-serialised in order to check the signature would
    // reject this — and would have passed every other test in this file,
    // because they all build their bodies with JSON.stringify.
    const raw = '{ "b": 2,\n  "a": "\\u00e9" }';

    const response = await postRaw(app, raw, {
      'x-shopify-webhook-id': 'delivery-spacing',
    });

    expect(response.status).toBe(200);
  });
});

describe('the topic-to-job map', () => {
  it('has an entry for every topic the app subscribes to', () => {
    // A topic added to shopify.app.toml and not here is a 400 on a real
    // delivery; the shared constant is what both sides are checked against.
    expect(Object.keys(JOB_KIND_BY_TOPIC).toSorted()).toEqual([
      'app/uninstalled',
      'customers/data_request',
      'customers/redact',
      'orders/create',
      'products/update',
      'shop/redact',
    ]);
  });
});
