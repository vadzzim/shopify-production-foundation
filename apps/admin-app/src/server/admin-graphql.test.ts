import {
  GraphqlQueryError,
  HttpInternalError,
  HttpMaxRetriesError,
  HttpRequestError,
  HttpResponseError,
  HttpThrottlingError,
} from '@shopify/shopify-api';
import { createRequire } from 'node:module';
import type * as ShopifyApi from '@shopify/shopify-api';
import { describe, expect, it } from 'vitest';

import { AdminApiError, errorsFromThrown, unwrap } from './admin-graphql';

/**
 * These tests exist because the SDK's response type is misleading twice over.
 *
 * `GraphQLClientResponse` declares an `errors` field, so the obvious reading is
 * that a failed call returns one. It does not — `GraphqlClient.request()` calls
 * `throwFailedRequest`, so every failure arrives as an exception. And the
 * classes it throws cannot be recognised with `instanceof` from here, because
 * the package hands its CJS and ESM importers different copies of them.
 *
 * Both halves are pinned below: the errors are built with the SDK's own classes
 * rather than hand-rolled shapes, and the realm test builds one through
 * `require` — the copy the CJS-only express adapter actually throws.
 */
describe('errorsFromThrown', () => {
  it('keeps the graphQLErrors from a 200 the API rejected', () => {
    // The shape `throwFailedRequest` builds: HTTP 200, `body.errors`.
    const error = new GraphqlQueryError({
      message: "Field 'nope' doesn't exist on type 'Product'",
      response: {},
      body: {
        errors: {
          graphQLErrors: [
            { message: "Field 'nope' doesn't exist on type 'Product'" },
          ],
        },
      },
    });

    expect(errorsFromThrown(error)).toEqual({
      graphQLErrors: [
        { message: "Field 'nope' doesn't exist on type 'Product'" },
      ],
      message: "Field 'nope' doesn't exist on type 'Product'",
    });
  });

  it('keeps the status from an HTTP failure', () => {
    const error = new HttpResponseError({
      message: 'Received an error response (403 Forbidden) from Shopify',
      code: 403,
      statusText: 'Forbidden',
    });

    expect(errorsFromThrown(error)).toMatchObject({
      networkStatusCode: 403,
      message: expect.stringContaining('403'),
    });
  });

  it('treats a Shopify internal error as an HTTP failure, since it is one', () => {
    // HttpInternalError extends HttpResponseError; matching on the subclass
    // separately would be a branch that adds nothing.
    const error = new HttpInternalError({
      message: 'Shopify internal error',
      code: 503,
      statusText: 'Service Unavailable',
    });

    expect(errorsFromThrown(error)).toMatchObject({ networkStatusCode: 503 });
  });

  it('surfaces Retry-After when Shopify throttled the request', () => {
    const error = new HttpThrottlingError({
      message: 'Shopify is throttling requests',
      code: 429,
      statusText: 'Too Many Requests',
      retryAfter: 2.5,
    });

    expect(errorsFromThrown(error)).toMatchObject({
      networkStatusCode: 429,
      message: expect.stringContaining('Retry-After: 2.5s'),
    });
  });

  it('reports a request that never got a response, with no status to invent', () => {
    const result = errorsFromThrown(
      new HttpRequestError('Http request error, no response available'),
    );

    expect(result.networkStatusCode).toBeUndefined();
    expect(result.message).toContain('no response available');
  });

  it('handles the retry budget running out', () => {
    expect(
      errorsFromThrown(
        new HttpMaxRetriesError(
          'Attempted the maximum number of retries for HTTP request.',
        ),
      ),
    ).toEqual({
      message: 'Attempted the maximum number of retries for HTTP request.',
    });
  });

  it('does not choke on something that is not an Error', () => {
    expect(errorsFromThrown('socket hang up')).toEqual({
      message: 'socket hang up',
    });
  });

  it('recognises an error thrown by the CJS copy of the SDK, not just the ESM one', () => {
    // The bug this pins, found by pointing a real client at a shop that does
    // not resolve. `@shopify/shopify-app-express` is CJS-only, so the client
    // that throws is the CJS copy of @shopify/shopify-api, while an `import` in
    // our code gets the ESM copy. They are different class objects, so
    // `instanceof` is false and an earlier version of this function fell
    // through to the generic branch and dropped the HTTP status. `error.name`
    // is no help: ShopifyError never sets it, so it reads "Error".
    const require = createRequire(import.meta.url);
    const cjs = require('@shopify/shopify-api') as typeof ShopifyApi;

    expect(cjs.HttpResponseError).not.toBe(HttpResponseError);

    const error = new cjs.HttpResponseError({
      message: 'Received an error response (404 Not Found) from Shopify',
      code: 404,
      statusText: 'Not Found',
    });

    expect(error instanceof HttpResponseError).toBe(false);
    expect(error.name).toBe('Error');

    // Matched on shape, so the realm does not matter.
    expect(errorsFromThrown(error)).toMatchObject({
      networkStatusCode: 404,
      message: expect.stringContaining('404'),
    });
  });

  it('composes with unwrap into an AdminApiError carrying the reason', () => {
    // The whole point of the translation: the reason reaches the client as a
    // 502 with detail rather than a bare 500.
    const errors = errorsFromThrown(
      new HttpResponseError({
        message: 'Received an error response (503) from Shopify',
        code: 503,
        statusText: 'Service Unavailable',
      }),
    );

    try {
      unwrap('BundleProducts', { errors });
      expect.unreachable('unwrap should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminApiError);
      expect((error as AdminApiError).detail).toContain('HTTP 503');
    }
  });
});

describe('unwrap', () => {
  it('returns the data when there is any', () => {
    expect(unwrap('Q', { data: { shop: { name: 'NORDLYS' } } })).toEqual({
      shop: { name: 'NORDLYS' },
    });
  });

  it('throws when a response has neither data nor errors', () => {
    // Returning undefined instead would push this distinction into every call
    // site, and most call sites would get it wrong.
    expect(() => unwrap('Q', {})).toThrow(AdminApiError);
  });
});
