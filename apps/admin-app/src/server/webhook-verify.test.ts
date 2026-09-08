import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  signWebhookBody,
  verifyWebhook,
  WEBHOOK_HEADERS,
} from './webhook-verify';

/**
 * The four cases the definition of done names — valid, invalid, missing, and a
 * tampered body — plus the ones that only exist because of how this is wired.
 *
 * These are worth having as unit tests rather than only through the endpoint:
 * verification is the security boundary of the whole app, and every branch of
 * it should be reachable without a server, a database or a signature helper
 * that might share a bug with the code under test.
 */

const SECRET = 'shpss_test_secret_do_not_use';
const SHOP = 'ecorn-oj1cb5ll.myshopify.com';

function headersFor(
  body: Buffer,
  overrides: Record<string, string | string[] | undefined> = {},
): Record<string, string | string[] | undefined> {
  return {
    [WEBHOOK_HEADERS.hmac]: signWebhookBody(body, SECRET),
    [WEBHOOK_HEADERS.topic]: 'orders/create',
    [WEBHOOK_HEADERS.shop]: SHOP,
    [WEBHOOK_HEADERS.apiVersion]: '2026-07',
    [WEBHOOK_HEADERS.webhookId]: 'b54557e4-bdd9-4b37-8a5f-bf7d70bcd043',
    ...overrides,
  };
}

const body = Buffer.from(JSON.stringify({ id: 1, name: '#1001' }), 'utf8');

describe('verifyWebhook', () => {
  it('accepts a delivery signed with the app secret', () => {
    const result = verifyWebhook(
      { headers: headersFor(body), body },
      { secret: SECRET },
    );

    expect(result).toMatchObject({
      ok: true,
      headers: {
        topic: 'orders/create',
        shop: SHOP,
        apiVersion: '2026-07',
        webhookId: 'b54557e4-bdd9-4b37-8a5f-bf7d70bcd043',
      },
    });
  });

  it('rejects a signature computed with a different secret', () => {
    const forged = createHmac('sha256', 'not-the-secret')
      .update(body)
      .digest('base64');

    const result = verifyWebhook(
      { headers: headersFor(body, { [WEBHOOK_HEADERS.hmac]: forged }), body },
      { secret: SECRET },
    );

    // 401, not 400: Shopify's app review requirement for the compliance topics
    // asks specifically for Unauthorized on an invalid HMAC.
    expect(result).toEqual({
      ok: false,
      status: 401,
      reason: 'HMAC mismatch',
    });
  });

  it('rejects a delivery with no signature at all', () => {
    const headers = headersFor(body);
    delete headers[WEBHOOK_HEADERS.hmac];

    expect(verifyWebhook({ headers, body }, { secret: SECRET })).toEqual({
      ok: false,
      status: 401,
      reason: 'missing HMAC header',
    });
  });

  it('rejects a body altered after it was signed', () => {
    // The signature is genuine — for the original body. This is the case a
    // signature check exists for: an attacker who has seen one delivery and
    // replays it with different contents.
    const headers = headersFor(body);
    const tampered = Buffer.from(
      JSON.stringify({ id: 1, name: '#1001', total: '999999.00' }),
      'utf8',
    );

    expect(
      verifyWebhook({ headers, body: tampered }, { secret: SECRET }),
    ).toEqual({ ok: false, status: 401, reason: 'HMAC mismatch' });
  });

  it('rejects a single flipped byte in the body', () => {
    const headers = headersFor(body);
    const flipped = Buffer.from(body);
    flipped.writeUInt8(flipped.readUInt8(5) ^ 0x01, 5);

    expect(
      verifyWebhook({ headers, body: flipped }, { secret: SECRET }),
    ).toEqual({ ok: false, status: 401, reason: 'HMAC mismatch' });
  });

  it('rejects a signature of the right shape but the wrong length', () => {
    // `crypto.timingSafeEqual` throws on mismatched lengths rather than
    // returning false, so a short signature would be a 500 — an unauthenticated
    // caller crashing the handler — if the length were not checked first.
    const short = Buffer.from('too short').toString('base64');

    const result = verifyWebhook(
      { headers: headersFor(body, { [WEBHOOK_HEADERS.hmac]: short }), body },
      { secret: SECRET },
    );

    expect(result).toEqual({
      ok: false,
      status: 401,
      reason: 'HMAC mismatch',
    });
  });

  it('rejects an empty body', () => {
    const empty = Buffer.alloc(0);

    expect(
      verifyWebhook(
        { headers: headersFor(empty), body: empty },
        { secret: SECRET },
      ),
    ).toEqual({ ok: false, status: 400, reason: 'empty body' });
  });

  it('names the headers it is missing, once the signature has passed', () => {
    const headers = headersFor(body);
    delete headers[WEBHOOK_HEADERS.webhookId];
    delete headers[WEBHOOK_HEADERS.shop];

    const result = verifyWebhook({ headers, body }, { secret: SECRET });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 400 });
    expect(result.ok ? '' : result.reason).toContain(
      WEBHOOK_HEADERS.webhookId,
    );
    expect(result.ok ? '' : result.reason).toContain(WEBHOOK_HEADERS.shop);
  });

  it('rejects a signed delivery for a topic nothing here handles', () => {
    const result = verifyWebhook(
      {
        headers: headersFor(body, {
          [WEBHOOK_HEADERS.topic]: 'fulfillments/create',
        }),
        body,
      },
      { secret: SECRET },
    );

    expect(result).toEqual({
      ok: false,
      status: 400,
      reason: 'unhandled topic: fulfillments/create',
    });
  });

  it('carries the optional event id through when Shopify sends one', () => {
    const result = verifyWebhook(
      {
        headers: headersFor(body, {
          [WEBHOOK_HEADERS.eventId]: '7b8c9d0a-1234-5678-90ab-cdef12345678',
        }),
        body,
      },
      { secret: SECRET },
    );

    expect(result.ok && result.headers.eventId).toBe(
      '7b8c9d0a-1234-5678-90ab-cdef12345678',
    );
  });

  it('refuses a repeated header rather than picking one of the values', () => {
    const result = verifyWebhook(
      {
        headers: headersFor(body, {
          [WEBHOOK_HEADERS.hmac]: ['sig-a', 'sig-b'],
        }),
        body,
      },
      { secret: SECRET },
    );

    expect(result).toEqual({
      ok: false,
      status: 401,
      reason: 'missing HMAC header',
    });
  });

  it('rejects a request that carried no body at all', () => {
    // `express.raw` skips a request with no `Content-Length`, leaving
    // `req.body` undefined. Before this was handled the endpoint answered 500
    // to `curl -X POST` with no data — an unauthenticated caller reaching a
    // throw. Found by sending one against a running server.
    expect(
      verifyWebhook(
        { headers: headersFor(body), body: undefined },
        { secret: SECRET },
      ),
    ).toEqual({ ok: false, status: 400, reason: 'no body' });
  });

  it('throws, rather than rejecting, when the body has already been parsed', () => {
    // A wiring mistake, not a bad request: it means the route was mounted
    // behind express.json(). Verifying a re-serialised body would sometimes
    // pass, which is worse than failing.
    expect(() =>
      verifyWebhook(
        { headers: headersFor(body), body: { id: 1 } },
        { secret: SECRET },
      ),
    ).toThrow(/not a Buffer/);
  });

  it('signs the way Shopify documents: base64 HMAC-SHA256 of the raw bytes', () => {
    // Guards the helper the other tests sign with, so a bug in it cannot make
    // them all pass together.
    expect(signWebhookBody(body, SECRET)).toBe(
      createHmac('sha256', SECRET).update(body).digest('base64'),
    );
  });
});
