/**
 * A narrow view of the Admin GraphQL API.
 *
 * The rest of the server depends on {@link AdminGraphql} — one function — rather
 * than on `shopify.api.clients.Graphql`. That keeps the request/response shape
 * of the SDK in one file, and it means the store-setup and bundle logic can be
 * tested against a fake executor instead of a live store.
 */

/** Shopify's leaky-bucket state, returned on `extensions.cost`. */
export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export interface GraphqlCost {
  requestedQueryCost?: number;
  actualQueryCost?: number | null;
  throttleStatus?: Partial<ThrottleStatus>;
}

/** Matches `ClientResponse` from `@shopify/graphql-client`. */
export interface AdminGraphqlResponse<T> {
  data?: T;
  errors?: {
    message?: string;
    networkStatusCode?: number;
    graphQLErrors?: { message: string }[];
  };
  extensions?: { cost?: GraphqlCost };
}

export type AdminGraphql = <T>(
  document: string,
  variables?: Record<string, unknown>,
) => Promise<AdminGraphqlResponse<T>>;

/** A transport-level or query-level failure. Distinct from `userErrors`. */
export class AdminApiError extends Error {
  readonly operation: string;
  readonly detail: readonly string[];

  constructor(operation: string, detail: readonly string[]) {
    super(`Admin API call "${operation}" failed: ${detail.join('; ')}`);
    this.name = 'AdminApiError';
    this.operation = operation;
    this.detail = detail;
  }
}

/**
 * Return `data`, or throw with everything the response said about why not.
 *
 * A GraphQL response can carry `errors` and still be HTTP 200, and it can carry
 * neither `errors` nor `data` when the request never reached the API. Both are
 * failures; returning `undefined` from here would push the distinction into
 * every call site.
 */
export function unwrap<T>(
  operation: string,
  response: AdminGraphqlResponse<T>,
): T {
  const { errors, data } = response;

  if (errors) {
    const messages = [
      ...(errors.graphQLErrors?.map((error) => error.message) ?? []),
      ...(errors.message ? [errors.message] : []),
    ];
    const status = errors.networkStatusCode;

    throw new AdminApiError(operation, [
      ...(status ? [`HTTP ${status}`] : []),
      ...(messages.length > 0 ? messages : ['no error message returned']),
    ]);
  }

  if (data === undefined || data === null) {
    throw new AdminApiError(operation, ['the response contained no data']);
  }

  return data;
}

/**
 * Turn an exception from `GraphqlClient.request()` into the response shape
 * above.
 *
 * Two things make this necessary, and neither is visible from the type
 * definitions.
 *
 * **The SDK throws instead of returning `errors`.** `GraphQLClientResponse`
 * declares an `errors` field, so the obvious reading is that a failed call
 * returns one. It does not: `request()` checks the underlying response and calls
 * `throwFailedRequest`, so a GraphQL error on an HTTP 200 arrives as a thrown
 * `GraphqlQueryError`, an HTTP failure as an `HttpResponseError`, and a request
 * that never reached Shopify as a plain `ShopifyError`. Nothing ever returns
 * with `errors` populated. Left alone, every real Shopify failure sails past
 * {@link unwrap} into the generic handler, and the merchant is told something
 * went wrong on our side during an outage that was not on our side.
 *
 * **`instanceof` cannot identify those errors here.** `@shopify/shopify-api`
 * ships both a CJS and an ESM build, and its `exports` map hands each importer a
 * different copy of every class. `@shopify/shopify-app-express` is CJS-only, so
 * the client that throws is the CJS copy, while an `import` in this file gets
 * the ESM copy — different class objects, so `instanceof` is always false. That
 * was verified against a live request, not reasoned about: an earlier version of
 * this function used `instanceof` and quietly fell through to the generic
 * branch, losing the HTTP status. `error.name` is no help either; `ShopifyError`
 * never sets it, so every one of them reports `"Error"`.
 *
 * So the errors are matched on shape. That is not a shortcut around the type
 * system — across a dual-package boundary it is the only identity these objects
 * actually carry.
 */

/** `HttpResponseError` and its subclasses, including throttling. */
interface HttpErrorShape {
  message?: unknown;
  response: { code: number; retryAfter?: unknown };
}

/** `GraphqlQueryError`: HTTP 200, with the failure inside the body. */
interface GraphqlErrorShape {
  message?: unknown;
  body: { errors?: { graphQLErrors?: { message: string }[] } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isHttpError(error: unknown): error is HttpErrorShape {
  if (!isRecord(error) || !isRecord(error.response)) return false;
  return typeof error.response.code === 'number';
}

function isGraphqlError(error: unknown): error is GraphqlErrorShape {
  if (!isRecord(error) || !isRecord(error.body)) return false;
  return isRecord(error.body.errors);
}

function messageOf(error: { message?: unknown }, fallback: string): string {
  return typeof error.message === 'string' && error.message.length > 0
    ? error.message
    : fallback;
}

export function errorsFromThrown(
  error: unknown,
): NonNullable<AdminGraphqlResponse<never>['errors']> {
  if (isGraphqlError(error)) {
    // The array names which field or argument the API rejected, which is the
    // only actionable part of this failure.
    const graphQLErrors = error.body.errors?.graphQLErrors;

    return {
      ...(graphQLErrors ? { graphQLErrors } : {}),
      message: messageOf(error, 'GraphQL operation failed'),
    };
  }

  if (isHttpError(error)) {
    const { code, retryAfter } = error.response;
    const message = messageOf(error, `Shopify answered ${code}`);

    return {
      networkStatusCode: code,
      message:
        typeof retryAfter === 'number'
          ? `${message} (Retry-After: ${retryAfter}s)`
          : message,
    };
  }

  if (error instanceof Error) {
    // A request with no response to report a status from: a DNS failure, an
    // aborted socket, or the SDK's retry budget running out.
    return { message: error.message };
  }

  return { message: String(error) };
}
