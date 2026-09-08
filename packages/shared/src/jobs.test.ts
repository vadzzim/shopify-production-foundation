import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  COMPLIANCE_TOPICS,
  WEBHOOK_TOPICS,
  inventoryPushPayloadSchema,
  jobSummarySchema,
  webhookTopicSchema,
} from './jobs';

const repositoryRoot = new URL('../../../', import.meta.url);

function appConfig(): string {
  return readFileSync(
    fileURLToPath(new URL('shopify.app.toml', repositoryRoot)),
    'utf8',
  );
}

/**
 * The subscriptions in `shopify.app.toml` against the topics the code knows.
 *
 * This is the same class of guard as the API version test next door, and it
 * exists because both halves of the mismatch are silent. A topic subscribed to
 * with no handler behind it is answered 400 on a live delivery — visible only
 * in Shopify's own delivery log, which nobody reads until something is already
 * wrong. A handler with no subscription in front of it is code that simply
 * never runs, and looks fine in every test.
 *
 * `shopify app config link` rewrites this file wholesale, so the guard also
 * catches the CLI dropping a block, which it has done before with other keys.
 */
describe('webhook subscriptions in shopify.app.toml', () => {
  it('subscribes to exactly the topics the app handles', () => {
    const config = appConfig();

    // The `topics = [...]` array of the non-compliance subscription block.
    const match = /^\s*topics\s*=\s*\[([^\]]*)\]/m.exec(config);
    const declared = [...(match?.[1] ?? '').matchAll(/"([^"]+)"/g)].map(
      (entry) => entry[1],
    );

    expect(declared.toSorted()).toEqual([...WEBHOOK_TOPICS].toSorted());
  });

  it('declares all three mandatory compliance topics', () => {
    const config = appConfig();

    const match = /compliance_topics\s*=\s*\[([^\]]*)\]/m.exec(config);
    const declared = [...(match?.[1] ?? '').matchAll(/"([^"]+)"/g)].map(
      (entry) => entry[1],
    );

    // Not optional and not ours to choose: Shopify's app review rejects an app
    // that does not subscribe to all three.
    expect(declared.toSorted()).toEqual([...COMPLIANCE_TOPICS].toSorted());
  });

  it('points every subscription at the path the server serves', () => {
    const config = appConfig();

    const uris = [...config.matchAll(/^\s*uri\s*=\s*"([^"]+)"/gm)].map(
      (entry) => entry[1],
    );

    // Matches `webhooks.path` in apps/admin-app/src/server/shopify.ts. A
    // mismatch is a 404 on every delivery.
    expect(uris.length).toBeGreaterThan(0);
    expect(new Set(uris)).toEqual(new Set(['/api/webhooks']));
  });

  it('keeps the compliance topics out of the ordinary topics list', () => {
    // They are declared under `compliance_topics`, and putting one under
    // `topics` is rejected by the CLI — but only at deploy time, which is late.
    for (const topic of COMPLIANCE_TOPICS) {
      expect(WEBHOOK_TOPICS).not.toContain(topic);
    }
  });
});

describe('webhookTopicSchema', () => {
  it('accepts every topic the app subscribes to', () => {
    for (const topic of [...WEBHOOK_TOPICS, ...COMPLIANCE_TOPICS]) {
      expect(webhookTopicSchema.safeParse(topic).success).toBe(true);
    }
  });

  it('rejects a topic nothing here handles', () => {
    expect(webhookTopicSchema.safeParse('fulfillments/create').success).toBe(
      false,
    );
  });
});

describe('inventoryPushPayloadSchema', () => {
  it('requires an InventoryItem gid, not a variant', () => {
    // The domain mistake this schema exists to catch: stock lives on the
    // InventoryItem × Location pair, and "set variant X to 40" is not something
    // the Admin API can be asked.
    expect(
      inventoryPushPayloadSchema.safeParse({
        inventoryItemId: 'gid://shopify/ProductVariant/1',
        locationId: 'gid://shopify/Location/1',
        quantity: 40,
      }).success,
    ).toBe(false);
  });

  it('requires a location', () => {
    expect(
      inventoryPushPayloadSchema.safeParse({
        inventoryItemId: 'gid://shopify/InventoryItem/1',
        quantity: 40,
      }).success,
    ).toBe(false);
  });

  it('accepts a well-formed push', () => {
    expect(
      inventoryPushPayloadSchema.safeParse({
        inventoryItemId: 'gid://shopify/InventoryItem/1',
        locationId: 'gid://shopify/Location/1',
        quantity: 0,
      }).success,
    ).toBe(true);
  });

  it('rejects a fractional quantity', () => {
    expect(
      inventoryPushPayloadSchema.safeParse({
        inventoryItemId: 'gid://shopify/InventoryItem/1',
        locationId: 'gid://shopify/Location/1',
        quantity: 1.5,
      }).success,
    ).toBe(false);
  });
});

describe('jobSummarySchema', () => {
  it('validates a row of the sync log as the browser will receive it', () => {
    const parsed = jobSummarySchema.safeParse({
      id: 'job-1',
      kind: 'inventory.push',
      status: 'dead',
      attempts: 5,
      maxAttempts: 5,
      runAt: '2026-09-08T00:00:00.000Z',
      createdAt: '2026-09-08T00:00:00.000Z',
      finishedAt: '2026-09-08T00:01:00.000Z',
      lastError: 'Shopify answered 503',
      correlationId: 'delivery-1',
      topic: null,
    });

    expect(parsed.success).toBe(true);
  });
});
