import type { InventoryPushPayload } from '@nordlys/shared';

import { unwrap, type AdminGraphql } from './admin-graphql';
import { SET_INVENTORY_ON_HAND } from './graphql-documents';
import { assertNoUserErrors, type ShopifyUserError } from './user-errors';

/**
 * Writing stock back to Shopify.
 *
 * The domain fact this module exists to encode: **inventory does not live on
 * the variant.** A product variant has exactly one `InventoryItem`, and that
 * item has an independent quantity at every `Location` the shop stocks it in.
 * "Set this variant to 40" is not a thing the Admin API can be asked, and an
 * integration written as though it were will work on a single-location store
 * and start writing to an arbitrary warehouse the day the merchant opens a
 * second one. So the pair is what this function takes, and the pair is what the
 * payload schema in `@nordlys/shared` requires.
 *
 * The quantity is absolute, not a delta. Deltas do not survive a retry: a
 * "-3 units" message delivered twice removes six. An absolute value applied
 * twice leaves the same number, which is what makes a queue with at-least-once
 * delivery safe to point at inventory at all.
 */

export interface InventoryChange {
  name: string;
  delta: number;
  quantityAfterChange: number | null;
}

export interface InventoryPushResult {
  changes: readonly InventoryChange[];
  /** Tolerated `userErrors`, if any — kept so the caller can report them. */
  tolerated: readonly ShopifyUserError[];
}

interface SetQuantitiesResponse {
  inventorySetQuantities?: {
    inventoryAdjustmentGroup?: {
      createdAt: string;
      reason: string;
      referenceDocumentUri: string | null;
      changes: InventoryChange[] | null;
    } | null;
    userErrors?: ShopifyUserError[] | null;
  } | null;
}

export interface PushInventoryOptions {
  /**
   * The idempotency key Shopify requires on this mutation since 2026-04.
   *
   * The job id is passed in as this key, and that is the whole reason the
   * retry story holds together. A queue with at-least-once delivery will re-run
   * a job whose result it never learned — a socket closed after Shopify applied
   * the write, say. Re-sending with the same key makes Shopify recognise the
   * repeat and return the original outcome instead of applying it twice.
   *
   * It follows that a *retry* must reuse the key, and a genuinely new
   * instruction must not. Deriving it from the job id gives both for free: the
   * queue retries the same row, and a new instruction is a new row.
   */
  idempotencyKey: string;
  /**
   * Recorded on the adjustment group so a merchant looking at the inventory
   * history in the admin can see what caused a change. Shopify constrains this
   * to a fixed vocabulary; `correction` is the one that means "an external
   * system is asserting the true number".
   */
  reason?: string;
}

export async function pushInventoryOnHand(
  graphql: AdminGraphql,
  payload: InventoryPushPayload,
  options: PushInventoryOptions,
): Promise<InventoryPushResult> {
  const response = await graphql<SetQuantitiesResponse>(
    SET_INVENTORY_ON_HAND,
    {
      input: {
        // `on_hand` is physical stock. `available` is Shopify's own derived
        // figure — on hand minus what is committed to unfulfilled orders — and
        // setting it directly overwrites that arithmetic with a number the
        // external system had no way to compute.
        name: 'on_hand',
        reason: options.reason ?? 'correction',
        ...(payload.referenceDocumentUri
          ? { referenceDocumentUri: payload.referenceDocumentUri }
          : {}),
        quantities: [
          {
            inventoryItemId: payload.inventoryItemId,
            locationId: payload.locationId,
            quantity: payload.quantity,
          },
        ],
      },
      idempotencyKey: options.idempotencyKey,
    },
  );

  const data = unwrap('inventorySetQuantities', response);
  const result = data.inventorySetQuantities;

  // Rule 2. A mutation can answer 200 with no `errors` and still not have
  // applied; for inventory that means the app reports a stock level it did not
  // set, and the storefront keeps selling something the warehouse does not
  // have. Nothing here is tolerated: unlike the install step, where `TAKEN`
  // means the desired state already holds, every `userError` on this mutation
  // means the number was not written.
  const tolerated = assertNoUserErrors(
    'inventorySetQuantities',
    result?.userErrors,
  );

  if (!result?.inventoryAdjustmentGroup) {
    // No errors, no adjustment group. Shopify returns the group on success, so
    // its absence is a response this code does not understand — reported rather
    // than treated as a silent success.
    throw new Error(
      'inventorySetQuantities returned no adjustment group and no userErrors.',
    );
  }

  return {
    changes: result.inventoryAdjustmentGroup.changes ?? [],
    tolerated,
  };
}
