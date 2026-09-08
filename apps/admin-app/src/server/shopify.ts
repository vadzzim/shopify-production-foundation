import type { Session } from '@shopify/shopify-api';
import { shopifyApp } from '@shopify/shopify-app-express';
import { PrismaSessionStorage } from '@shopify/shopify-app-session-storage-prisma';

import { errorsFromThrown, type AdminGraphql } from './admin-graphql';
import { prisma } from './db';
import { env } from './env';
import { logger } from './logger';
import { resolveApiVersion } from './resolve-api-version';
import { prepareStoreAfterAuth } from './store-preparation';

/**
 * The Shopify integration.
 *
 * `shopifyApp` from `@shopify/shopify-app-express` supplies OAuth, session
 * token verification and the embedding headers. Choosing Express over Shopify's
 * default app template is argued in ADR-0002; the short version is that this
 * package is on the same release train as the template's own
 * (`@shopify/shopify-app-react-router`), so the authentication code is vendor
 * maintained either way - what differs is the framework wrapped around it.
 */
export const shopify = shopifyApp({
  api: {
    apiKey: env.SHOPIFY_API_KEY,
    apiSecretKey: env.SHOPIFY_API_SECRET,
    scopes: env.SHOPIFY_SCOPES,
    // The SDK wants host and scheme apart. Embedded apps are framed by the
    // admin, which is HTTPS, so an http app URL is refused by the browser
    // rather than by us - hence the https check in the env schema.
    hostName: new URL(env.SHOPIFY_APP_URL).host,
    hostScheme: 'https',
    // Never inline, never from an env var: ADR-0009.
    apiVersion: resolveApiVersion(),
    isEmbeddedApp: true,
  },
  auth: {
    path: '/api/auth',
    callbackPath: '/api/auth/callback',
  },
  webhooks: {
    /**
     * The path Shopify posts to. It matches `uri` in the
     * `[[webhooks.subscriptions]]` block of `shopify.app.toml`, and a test
     * asserts the two agree.
     *
     * `shopify.processWebhooks()` is deliberately **not** used to serve it. The
     * receiver in `webhook-router.ts` is mounted there instead, because the
     * adapter's middleware verifies the HMAC over a decoded string rather than
     * the raw `Buffer`, compares with a hand-written loop rather than
     * `crypto.timingSafeEqual`, and writes its response only after every
     * handler has finished — three requirements of rule 3, in one function.
     * The evidence and the trade-off are in ADR-0016.
     */
    path: '/api/webhooks',
  },
  /**
   * Both token kinds.
   *
   * An online token belongs to the staff member currently looking at the app:
   * it carries their permissions and expires with their admin session, which is
   * what user-facing requests should act under - a staff member without product
   * permissions should not be able to edit products through our UI.
   *
   * An offline token belongs to the shop and does not expire with anyone's
   * session. Background work needs it: webhooks arrive when nobody is in the
   * admin, and the sync worker runs on a schedule. With online tokens only,
   * every background task would fail whenever no staff member happened to be
   * logged in.
   */
  useOnlineTokens: true,
  sessionStorage: new PrismaSessionStorage(prisma),
  hooks: {
    // Preparation is not inlined here. `afterAuth` only ever fires for the
    // online session when `useOnlineTokens` is on — the adapter returns from
    // the offline callback before reaching the hook — and getting that wrong
    // once already meant a fresh install silently had no definitions. The logic
    // and the reasoning live in store-preparation.ts, where a test can reach
    // them.
    afterAuth: async ({ session }) => {
      await prepareStoreAfterAuth(session.shop, {
        loadOfflineSession,
        graphqlFor: adminGraphqlFor,
        log: logger,
      });
    },
  },
});

/**
 * An {@link AdminGraphql} bound to one session.
 *
 * `retries` lets the SDK re-send a request Shopify throttled. It is the safety
 * net, not the strategy: loops pace themselves with the throttle gate in
 * `throttle.ts` so that the common case never spends a request being rejected.
 *
 * The `catch` is not defensive padding. `GraphqlClient.request()` throws on
 * every kind of failure rather than returning the `errors` field its response
 * type declares, so without this translation a Shopify outage or a rejected
 * document would bypass `unwrap` entirely and reach the client as a generic
 * 500 with no reason attached.
 */
export function adminGraphqlFor(session: Session): AdminGraphql {
  const client = new shopify.api.clients.Graphql({ session });

  return async <T>(document: string, variables?: Record<string, unknown>) => {
    try {
      return await client.request<T>(document, { variables, retries: 2 });
    } catch (error) {
      return { errors: errorsFromThrown(error) };
    }
  };
}

/**
 * The shop's offline session, read from storage.
 *
 * `shopify.ensureValidOfflineSession()` looks like the method for this and is
 * not usable: it throws unless the `expiringOfflineAccessTokens` future flag is
 * on, which it is not. This is what that helper does underneath.
 */
async function loadOfflineSession(shop: string): Promise<Session | undefined> {
  const offlineId = shopify.api.session.getOfflineId(shop);
  return shopify.config.sessionStorage.loadSession(offlineId);
}

/**
 * An Admin API client for a shop, on its offline token.
 *
 * This is what background work runs under. A job is executed when the queue
 * reaches it, which is routinely long after the staff member who caused it
 * closed the tab and their online token expired with their admin session; a
 * worker holding an online token would fail on exactly the deliveries that
 * arrive out of hours.
 */
export async function offlineGraphqlFor(shop: string): Promise<AdminGraphql> {
  const session = await loadOfflineSession(shop);

  if (!session) {
    // The app is not installed on this shop, or the session row is gone. Not a
    // transient failure, so it says so plainly rather than letting the queue
    // retry it five times against a shop that has uninstalled.
    throw new Error(`No offline session stored for ${shop}.`);
  }

  return adminGraphqlFor(session);
}
