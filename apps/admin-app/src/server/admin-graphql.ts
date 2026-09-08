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
