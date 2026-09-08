import type { StoreSetupReport } from '@nordlys/shared';

import type { AdminGraphql } from './admin-graphql';
import { ensureStoreDefinitions } from './store-setup';

/**
 * What runs after OAuth, extracted from the `afterAuth` hook so it can be
 * tested.
 *
 * It lives in its own module because the bug it now guards against was a wiring
 * bug, and wiring inside a `shopifyApp({...})` config literal cannot be reached
 * by a test: importing that module builds a Shopify client, opens a Prisma
 * connection pool and requires a populated environment.
 *
 * The bug: the hook used to start with `if (session.isOnline) return`, on the
 * assumption that `afterAuth` fires for both sessions and that preparation
 * belongs on the offline pass. It does not fire for both. With
 * `useOnlineTokens` enabled, the adapter completes the offline callback by
 * storing the session, registering webhooks and redirecting into the online
 * OAuth — returning before the hook runs — so the hook only ever sees the
 * online session, and the guard skipped every install. A freshly installed app
 * had no metafield definitions and said nothing about it.
 */

export interface StorePreparationDeps<Session> {
  /** The shop's offline session, or `undefined` if none is stored. */
  loadOfflineSession: (shop: string) => Promise<Session | undefined>;
  graphqlFor: (session: Session) => AdminGraphql;
  log: {
    info: (message: string, detail?: unknown) => void;
    error: (message: string, detail?: unknown) => void;
  };
  /** Overridden only in tests. */
  ensureDefinitions?: (graphql: AdminGraphql) => Promise<StoreSetupReport>;
}

/**
 * Create the definitions the theme needs, using the shop's **offline** token.
 *
 * The offline token is used deliberately, whichever session triggered this.
 * Preparation is per shop rather than per staff member, and the offline token is
 * the one webhooks and the phase 3 worker will hold — so exercising it here is
 * the honest test of it, and it does not depend on who happened to install the
 * app.
 *
 * Never throws. A failed definition must not break the install: the merchant
 * would be left with an app they cannot open and no way to retry. The failure is
 * logged, and the app's "Prepare store" action runs the same code on demand, so
 * it stays visible and fixable rather than silent.
 *
 * @returns the report on success, or `undefined` if preparation did not run.
 */
export async function prepareStoreAfterAuth<Session>(
  shop: string,
  deps: StorePreparationDeps<Session>,
): Promise<StoreSetupReport | undefined> {
  const ensure = deps.ensureDefinitions ?? ensureStoreDefinitions;

  const offlineSession = await deps.loadOfflineSession(shop);

  if (!offlineSession) {
    deps.log.error(
      `No offline session stored for ${shop}, so the store was not prepared. ` +
        `The app is installed; "Prepare store" inside it will retry once an ` +
        `offline token exists.`,
    );
    return undefined;
  }

  try {
    const report = await ensure(deps.graphqlFor(offlineSession));
    deps.log.info(`Store prepared for ${shop}`, report.results);
    return report;
  } catch (error) {
    deps.log.error(
      `Store preparation failed for ${shop}; the app is installed but the ` +
        `theme's metafields may be missing. Retry with "Prepare store".`,
      error,
    );
    return undefined;
  }
}
