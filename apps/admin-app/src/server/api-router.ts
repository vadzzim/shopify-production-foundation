import express, {
  type ErrorRequestHandler,
  type Response,
  type Router,
} from 'express';
import type { PrismaClient } from '@prisma/client';
import { bundleUpdateSchema, type ApiError } from '@nordlys/shared';

import { AdminApiError, type AdminGraphql } from './admin-graphql';
import {
  BundleNotFoundError,
  BundleValidationError,
  createStarterBundle,
  deleteBundle,
  listBundles,
  listCandidateProducts,
  updateBundle,
} from './bundles';
import { requestCatalogExport } from './catalog-export';
import { logger } from './logger';
import { ensureStoreDefinitions } from './store-setup';
import {
  JobNotRetryableError,
  latestCatalogExport,
  listJobs,
  retryJob,
} from './sync-log';
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

  if (error instanceof BundleNotFoundError) {
    // 404 for a bundle belonging to another shop as well as for one that does
    // not exist. The distinction is real but not the caller's to learn: telling
    // them "that id exists, just not for you" is a cross-tenant disclosure.
    sendError(res, 'not_found', error.message);
    return;
  }

  if (error instanceof JobNotRetryableError) {
    // 404 rather than 409: from the caller's side a job that is not theirs, not
    // there, or not in a retryable state are the same answer — this id is not
    // something you can retry — and the message says which.
    sendError(res, 'not_found', error.message);
    return;
  }

  if (error instanceof UserErrorsError) {
    logger.error(`${error.operation} returned userErrors`, {
      userErrors: error.userErrors,
    });
    sendError(
      res,
      'shopify_api',
      `Shopify refused the change (${error.operation}).`,
      error.userErrors.map(formatUserError),
    );
    return;
  }

  if (error instanceof AdminApiError) {
    logger.error(`Admin API call failed: ${error.operation}`, {
      detail: error.detail,
    });
    sendError(
      res,
      'shopify_api',
      'The Shopify Admin API did not answer as expected.',
      error.detail,
    );
    return;
  }

  logger.error('Unhandled error in an API route', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
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

  router.patch('/bundles/:id', async (req, res) => {
    const { shop, graphql } = deps.contextFor(res);
    const parsed = bundleUpdateSchema.safeParse(req.body);

    if (!parsed.success) {
      // The issues verbatim, one per field. `detail` is rendered as a list in
      // the error banner, so "items: the same product is used for more than one
      // step" reaches the merchant instead of "invalid request".
      throw new BundleValidationError(
        'This change was not accepted.',
        parsed.error.issues.map(
          (issue) => `${issue.path.join('.') || '(body)'}: ${issue.message}`,
        ),
      );
    }

    const bundle = await updateBundle(
      deps.prisma,
      graphql,
      shop,
      req.params.id,
      parsed.data,
    );
    res.json({ bundle });
  });

  router.delete('/bundles/:id', async (req, res) => {
    const { shop } = deps.contextFor(res);
    await deleteBundle(deps.prisma, shop, req.params.id);
    // 204 rather than the deleted row: there is nothing left to describe, and
    // returning a body invites a client to render what it just removed.
    res.status(204).end();
  });

  router.get('/catalog/candidates', async (_req, res) => {
    const { graphql } = deps.contextFor(res);
    res.json(await listCandidateProducts(graphql));
  });

  router.get('/catalog/export', async (_req, res) => {
    const { shop } = deps.contextFor(res);
    res.json(await latestCatalogExport(deps.prisma, shop));
  });

  router.post('/catalog/export', async (_req, res) => {
    const { shop } = deps.contextFor(res);
    const { alreadyRunning } = await requestCatalogExport(deps.prisma, shop);

    if (alreadyRunning) {
      logger.info('Catalog export already in flight; not starting a second', {
        shop,
      });
    }

    // 202, not 201: a bulk operation finishes minutes later, so there is
    // nothing created to point at. The body is the same shape GET returns, so
    // the screen can render the queued job without a second request.
    res.status(202).json(await latestCatalogExport(deps.prisma, shop));
  });

  router.get('/jobs', async (_req, res) => {
    const { shop } = deps.contextFor(res);
    res.json({ jobs: await listJobs(deps.prisma, shop) });
  });

  router.post('/jobs/:id/retry', async (req, res) => {
    const { shop } = deps.contextFor(res);
    const job = await retryJob(deps.prisma, shop, req.params.id);
    res.json({ job });
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
