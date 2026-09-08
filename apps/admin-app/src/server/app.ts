import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import express, { type Express, type Response } from 'express';
import type { Session } from '@shopify/shopify-api';

import { createApiRouter, type RequestContext } from './api-router';
import { prisma } from './db';
import { env } from './env';
import { logger } from './logger';
import { adminGraphqlFor, shopify } from './shopify';

/**
 * One Express app serves the API and the embedded screen.
 *
 * They cannot be split across two origins: the admin frames the app at
 * `SHOPIFY_APP_URL`, and a UI fetching an API on another host would be a
 * cross-origin request from inside an iframe with a session token to forward.
 * So in development Vite runs as middleware inside this server rather than on
 * its own port, and in production the same server hands out the built assets.
 */

// Kept as URLs and converted only where a plain path is required. Joining
// Windows paths as strings and prefixing "file://" produces a URL Node rejects.
const webRootUrl = new URL('../web/', import.meta.url);
const builtWebRootUrl = new URL('../../dist/web/', import.meta.url);

function sessionFrom(res: Response): Session {
  const session = (res.locals as { shopify?: { session?: Session } }).shopify
    ?.session;

  if (!session) {
    // Reaching here means the route was mounted outside
    // validateAuthenticatedSession. That is a wiring mistake, not a request the
    // client can fix, so it is loud rather than a 401.
    throw new Error(
      'No Shopify session on res.locals. The route is mounted without ' +
        'shopify.validateAuthenticatedSession().',
    );
  }

  return session;
}

function contextFor(res: Response): RequestContext {
  const session = sessionFrom(res);
  return { shop: session.shop, graphql: adminGraphqlFor(session) };
}

/**
 * The app's API key is public - it identifies the app to App Bridge in the
 * browser, the way a Stripe publishable key does. The secret never leaves the
 * server, which is why only this one value is injected into the document.
 */
function injectApiKey(html: string): string {
  return html.replaceAll('%SHOPIFY_API_KEY%', env.SHOPIFY_API_KEY);
}

export async function createApp(): Promise<Express> {
  const app = express();
  const isDevelopment = env.NODE_ENV === 'development';

  // OAuth. These two must stay outside the authenticated router below: they are
  // how a request gets a session in the first place.
  app.get(shopify.config.auth.path, shopify.auth.begin());
  app.get(
    shopify.config.auth.callbackPath,
    shopify.auth.callback(),
    shopify.redirectToShopifyOrAppRoot(),
  );

  // Everything else under /api needs a verified session token. Mounted as a
  // sub-app rather than matched with a wildcard, because Express 5's router
  // rejects the bare `/api/*` pattern that used to work.
  app.use(
    '/api',
    shopify.validateAuthenticatedSession(),
    createApiRouter({ prisma, contextFor }),
  );

  // Sets the frame-ancestors policy that lets the Shopify admin embed the page.
  app.use(shopify.cspHeaders());

  let renderIndex: (url: string) => Promise<string>;

  if (isDevelopment) {
    // Imported lazily: vite is a devDependency, so a production process must
    // never reach this branch, and a static import would break it at load time
    // rather than here where the reason is visible.
    const { createServer } = await import('vite');
    const vite = await createServer({
      root: fileURLToPath(webRootUrl),
      appType: 'custom',
      server: { middlewareMode: true },
    });

    app.use(vite.middlewares);

    renderIndex = async (url) => {
      // Re-read on every request: in development the file is expected to change
      // under the running server.
      const template = await readFile(new URL('index.html', webRootUrl), 'utf8');
      return injectApiKey(await vite.transformIndexHtml(url, template));
    };
  } else {
    app.use(express.static(fileURLToPath(builtWebRootUrl), { index: false }));

    const template = injectApiKey(
      await readFile(new URL('index.html', builtWebRootUrl), 'utf8'),
    );
    // Read once: in production the file cannot change under a running process.
    renderIndex = () => Promise.resolve(template);
  }

  // The single-page fallback. `ensureInstalledOnShop` turns a visit from a shop
  // that has not installed the app into the OAuth redirect instead of a blank
  // screen.
  app.use(shopify.ensureInstalledOnShop(), async (req, res) => {
    res
      .status(200)
      .set('Content-Type', 'text/html')
      .send(await renderIndex(req.originalUrl));
  });

  logger.debug(`App created in ${env.NODE_ENV} mode`);

  return app;
}
