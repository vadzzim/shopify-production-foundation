import type { Session } from '@shopify/shopify-api';
import { shopifyApp } from '@shopify/shopify-app-express';
import { PrismaSessionStorage } from '@shopify/shopify-app-session-storage-prisma';

import type { AdminGraphql, AdminGraphqlResponse } from './admin-graphql';
import { prisma } from './db';
import { env } from './env';
import { logger } from './logger';
import { resolveApiVersion } from './resolve-api-version';
import { ensureStoreDefinitions } from './store-setup';

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
    // Declared because the config requires it. No handler is mounted yet:
    // HMAC verification, idempotency and the queue are phase 3, and an endpoint
    // that accepts webhooks before it can process them idempotently would drop
    // deliveries silently.
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
    afterAuth: async ({ session }) => {
      // afterAuth fires for both sessions when online tokens are on. Store
      // preparation is per shop, not per staff member, so it runs on the
      // offline pass and uses the offline token - the one background work will
      // use later, which makes this the honest test of it.
      if (session.isOnline) return;

      try {
        const report = await ensureStoreDefinitions(adminGraphqlFor(session));
        logger.info(`Store prepared for ${session.shop}`, report.results);
      } catch (error) {
        // A failed definition must not block the install: the merchant would be
        // left with an app they cannot open and no way to retry. It is logged
        // here and the app offers "Prepare store" so the failure is visible and
        // actionable rather than silent.
        logger.error(
          `Store preparation failed for ${session.shop}; the app is installed ` +
            `but the theme's metafields may be missing. Retry from the app.`,
          error,
        );
      }
    },
  },
});

/**
 * An {@link AdminGraphql} bound to one session.
 *
 * `retries` lets the SDK re-send a request Shopify throttled. It is the safety
 * net, not the strategy: loops pace themselves with the throttle gate in
 * `throttle.ts` so that the common case never spends a request being rejected.
 */
export function adminGraphqlFor(session: Session): AdminGraphql {
  const client = new shopify.api.clients.Graphql({ session });

  return async <T>(document: string, variables?: Record<string, unknown>) => {
    const response = await client.request<T>(document, { variables, retries: 2 });
    return response as AdminGraphqlResponse<T>;
  };
}
