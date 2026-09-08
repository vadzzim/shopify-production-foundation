import type { StoreSetupReport } from '@nordlys/shared';
import { describe, expect, it, vi } from 'vitest';

import type { AdminGraphql } from './admin-graphql';
import { prepareStoreAfterAuth } from './store-preparation';

interface FakeSession {
  shop: string;
  isOnline: boolean;
  accessToken: string;
}

const SHOP = 'ecorn-oj1cb5ll.myshopify.com';

const offline: FakeSession = {
  shop: SHOP,
  isOnline: false,
  accessToken: 'offline-token',
};

const report: StoreSetupReport = {
  results: [{ definition: 'custom.routine_step', outcome: 'created' }],
  throttleWaitMs: 0,
};

function silentLog() {
  return { info: vi.fn(), error: vi.fn() };
}

const noopGraphql: AdminGraphql = async () => ({ data: {} as never });

describe('prepareStoreAfterAuth', () => {
  it('runs even though afterAuth only ever fires for the online session', async () => {
    // The regression this pins. With useOnlineTokens on, the express adapter
    // finishes the offline callback and redirects into the online OAuth before
    // reaching afterAuth, so the hook only sees `isOnline: true`. Skipping on
    // that — which an earlier version did — meant preparation never ran and a
    // fresh install had no metafield definitions, silently.
    const ensureDefinitions = vi.fn(async () => report);
    const log = silentLog();

    const result = await prepareStoreAfterAuth(SHOP, {
      loadOfflineSession: async () => offline,
      graphqlFor: () => noopGraphql,
      log,
      ensureDefinitions,
    });

    expect(ensureDefinitions).toHaveBeenCalledOnce();
    expect(result).toEqual(report);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('uses the offline token, not the session that triggered it', async () => {
    // Preparation is per shop, and the offline token is what webhooks and the
    // worker will hold. Running it against the staff member's online token
    // would mean the token background work depends on is never exercised.
    const graphqlFor = vi.fn((session: FakeSession) => {
      expect(session.accessToken).toBe('offline-token');
      return noopGraphql;
    });

    await prepareStoreAfterAuth(SHOP, {
      loadOfflineSession: async () => offline,
      graphqlFor,
      log: silentLog(),
      ensureDefinitions: async () => report,
    });

    expect(graphqlFor).toHaveBeenCalledWith(offline);
  });

  it('says so and gives up when no offline session is stored', async () => {
    const ensureDefinitions = vi.fn(async () => report);
    const log = silentLog();

    const result = await prepareStoreAfterAuth(SHOP, {
      loadOfflineSession: async () => undefined,
      graphqlFor: () => noopGraphql,
      log,
      ensureDefinitions,
    });

    expect(result).toBeUndefined();
    expect(ensureDefinitions).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('No offline session stored'),
    );
  });

  it('does not let a failed definition break the install', async () => {
    // Throwing here would abort the OAuth callback and leave the merchant with
    // an app they cannot open — a worse outcome than a store missing a
    // definition it can create later from a button.
    const log = silentLog();

    const result = await prepareStoreAfterAuth(SHOP, {
      loadOfflineSession: async () => offline,
      graphqlFor: () => noopGraphql,
      log,
      ensureDefinitions: async () => {
        throw new Error('Shopify refused the definition');
      },
    });

    expect(result).toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('Store preparation failed'),
      // The reason is carried as a named field rather than as a bare Error:
      // pino serialises the structured half of a line, and an Error passed as
      // the whole detail object logs as `{}`.
      { error: 'Shopify refused the definition' },
    );
  });
});
