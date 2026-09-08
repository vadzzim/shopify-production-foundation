import express, {
  type ErrorRequestHandler,
  type Response,
  type Router,
} from 'express';
import type { PrismaClient } from '@prisma/client';
import type { ApiError } from '@nordlys/shared';

import { AdminApiError, type AdminGraphql } from './admin-graphql';
import {
  BundleValidationError,
  createStarterBundle,
  listBundles,
} from './bundles';
import { logger } from './logger';
import { ensureStoreDefinitions } from './store-setup';
import { UserErrorsError, formatUserError } from './user-errors';

/**
 * The JSON API the embedded screen talks to.
 *
 * It takes its dependencies as arguments rather than importing them. That is
 * what makes it testable: the tests mount this router with a fake Admin API and
 * assert on real HTTP responses, without a tunnel, a store, or an OAuth
 * round trip.
 */
export interface RequestContext {
  shop: string;
  graphql: AdminGraphql;
}

export interface ApiRouterDeps {
  prisma: PrismaClient;
  /** Derive shop and Admin API client from the authenticated session. */
  contextFor: (res: Response) => RequestContext;
}

type ApiErrorCode = ApiError['error']['code'];

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  validation: 422,
  not_found: 404,
  // 502, not 500: the app worked, the upstream call did not. The distinction
  // matters when reading logs six months from now.
  shopify_api: 502,
  internal: 500,
};

function sendError(
  res: Response,
  code: ApiErrorCode,
  message: string,
  detail?: readonly string[],
): void {
  const body: ApiError = {
    error: {
      code,
      message,
      ...(detail && detail.length > 0 ? { detail: [...detail] } : {}),
    },
  };
  res.status(STATUS_BY_CODE[code]).json(body);
}

/**
 * Turn thrown errors into the one envelope the UI knows how to render.
 *
 * `userErrors` get their own branch on purpose. A mutation that came back 200
 * and did not apply is the failure mode rule 2 exists for, and its messages are
 * the only explanation of what Shopify refused - so they are passed through to
 * the merchant instead of being flattened into "something went wrong".
 */
export const apiErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof BundleValidationError) {
    sendError(res, 'validation', error.message, error.detail);
    return;
  }

  if (error instanceof UserErrorsError) {
    logger.error(`${error.operation} returned userErrors`, error.userErrors);
    sendError(
      res,
      'shopify_api',
      `Shopify refused the change (${error.operation}).`,
      error.userErrors.map(formatUserError),
    );
    return;
  }

  if (error instanceof AdminApiError) {
    logger.error(`Admin API call failed: ${error.operation}`, error.detail);
    sendError(
      res,
      'shopify_api',
      'The Shopify Admin API did not answer as expected.',
      error.detail,
    );
    return;
  }

  logger.error('Unhandled error in an API route', error);
  sendError(res, 'internal', 'Something went wrong on our side.');
};

export function createApiRouter(deps: ApiRouterDeps): Router {
  const router = express.Router();
  router.use(express.json());

  router.get('/bundles', async (_req, res) => {
    const { shop, graphql } = deps.contextFor(res);
    const bundles = await listBundles(deps.prisma, graphql, shop);
    res.json({ bundles });
  });

  router.post('/bundles/starter', async (_req, res) => {
    const { shop, graphql } = deps.contextFor(res);
    const bundle = await createStarterBundle(deps.prisma, graphql, shop);
    res.status(201).json({ bundle });
  });

  router.post('/store/prepare', async (_req, res) => {
    const { graphql } = deps.contextFor(res);
    const report = await ensureStoreDefinitions(graphql);
    res.json({ report });
  });

  router.use((_req, res) => {
    sendError(res, 'not_found', 'No such endpoint.');
  });

  router.use(apiErrorHandler);

  return router;
}
