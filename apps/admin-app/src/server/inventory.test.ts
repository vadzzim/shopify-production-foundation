import { describe, expect, it, vi } from 'vitest';

import type { AdminGraphql } from './admin-graphql';
import { AdminApiError } from './admin-graphql';
import { pushInventoryOnHand } from './inventory';
import { UserErrorsError } from './user-errors';

/**
 * Writing stock back to Shopify.
 *
 * The assertions that matter are about the *shape of the request*, not about
 * the response being unpacked: an inventory write aimed at the wrong pair, or
 * at `available` instead of `on_hand`, succeeds — and quietly corrupts the
 * merchant's stock. Nothing downstream would notice.
 */

const PAYLOAD = {
  inventoryItemId: 'gid://shopify/InventoryItem/30322695',
  locationId: 'gid://shopify/Location/124656943',
  quantity: 42,
};

/**
 * The variables of the first Admin API call, or a failure saying there was none.
 *
 * `mock.calls[0]` is `T | undefined` under `noUncheckedIndexedAccess`, and a
 * non-null assertion here would turn "the mutation was never sent" — the
 * interesting bug — into a property access on undefined.
 */
function sentVariables(graphql: AdminGraphql): Record<string, unknown> {
  const call = vi.mocked(graphql).mock.calls[0];
  if (!call) throw new Error('The Admin API was never called.');
  return call[1] ?? {};
}

function succeeding(): AdminGraphql {
  return vi.fn(async () => ({
    data: {
      inventorySetQuantities: {
        inventoryAdjustmentGroup: {
          createdAt: '2026-09-08T00:00:00Z',
          reason: 'Inventory correction',
          referenceDocumentUri: null,
          changes: [{ name: 'on_hand', delta: 12, quantityAfterChange: 42 }],
        },
        userErrors: [],
      },
    } as never,
  }));
}

describe('pushInventoryOnHand', () => {
  it('addresses the InventoryItem × Location pair, not a variant', async () => {
    const graphql = succeeding();

    await pushInventoryOnHand(graphql, PAYLOAD, { idempotencyKey: 'job-1' });

    expect(sentVariables(graphql).input).toMatchObject({
      quantities: [
        {
          inventoryItemId: PAYLOAD.inventoryItemId,
          locationId: PAYLOAD.locationId,
          quantity: 42,
        },
      ],
    });
  });

  it('writes on_hand rather than available', async () => {
    // `available` is Shopify's own figure — on hand minus what is committed to
    // unfulfilled orders. Setting it directly overwrites that arithmetic with a
    // number the external system had no way to compute.
    const graphql = succeeding();

    await pushInventoryOnHand(graphql, PAYLOAD, { idempotencyKey: 'job-1' });

    expect(sentVariables(graphql).input).toMatchObject({ name: 'on_hand' });
  });

  it('sends the job id as the idempotency key Shopify requires', async () => {
    // Required by the mutation since 2026-04, and the reason a queue retry
    // cannot double-apply a write: the retried row carries the same id.
    const graphql = succeeding();

    await pushInventoryOnHand(graphql, PAYLOAD, { idempotencyKey: 'job-42' });

    expect(sentVariables(graphql).idempotencyKey).toBe('job-42');
  });

  it('passes the reference document URI through for the audit trail', async () => {
    const graphql = succeeding();

    await pushInventoryOnHand(
      graphql,
      { ...PAYLOAD, referenceDocumentUri: 'https://erp.example.com/count/17' },
      { idempotencyKey: 'job-1' },
    );

    expect(sentVariables(graphql).input).toMatchObject({
      referenceDocumentUri: 'https://erp.example.com/count/17',
    });
  });

  it('returns the changes Shopify reported', async () => {
    const result = await pushInventoryOnHand(succeeding(), PAYLOAD, {
      idempotencyKey: 'job-1',
    });

    expect(result.changes).toEqual([
      { name: 'on_hand', delta: 12, quantityAfterChange: 42 },
    ]);
  });

  it('throws on userErrors instead of reporting a write that did not happen', async () => {
    // Rule 2. This mutation is the clearest case for it: a 200 with userErrors
    // and no handling means the app believes stock is 42 when Shopify still has
    // the old number, and the storefront keeps selling from it.
    const graphql: AdminGraphql = async () => ({
      data: {
        inventorySetQuantities: {
          inventoryAdjustmentGroup: null,
          userErrors: [
            {
              field: ['input', 'quantities', '0', 'inventoryItemId'],
              message: 'Inventory item does not exist',
              code: 'INVALID',
            },
          ],
        },
      } as never,
    });

    await expect(
      pushInventoryOnHand(graphql, PAYLOAD, { idempotencyKey: 'job-1' }),
    ).rejects.toBeInstanceOf(UserErrorsError);
  });

  it('reports a transport failure rather than treating it as a no-op', async () => {
    const graphql: AdminGraphql = async () => ({
      errors: { networkStatusCode: 503, message: 'Service Unavailable' },
    });

    await expect(
      pushInventoryOnHand(graphql, PAYLOAD, { idempotencyKey: 'job-1' }),
    ).rejects.toBeInstanceOf(AdminApiError);
  });

  it('refuses a response with neither an adjustment group nor errors', async () => {
    // Shopify returns the group on success. Its absence with no userErrors is a
    // response this code does not understand, and calling that a success would
    // record a stock level that was never written.
    const graphql: AdminGraphql = async () => ({
      data: {
        inventorySetQuantities: {
          inventoryAdjustmentGroup: null,
          userErrors: [],
        },
      } as never,
    });

    await expect(
      pushInventoryOnHand(graphql, PAYLOAD, { idempotencyKey: 'job-1' }),
    ).rejects.toThrow(/no adjustment group/);
  });
});
