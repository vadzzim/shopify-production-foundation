/**
 * `userErrors` handling.
 *
 * Rule 2 of `CLAUDE.md`: any GraphQL mutation can return HTTP 200, no `errors`,
 * and still not have applied. The failure is reported in the payload's
 * `userErrors` array, and code that does not read it reports success for work
 * that never happened. This module makes ignoring them require deliberate
 * effort rather than being the default.
 */

export interface ShopifyUserError {
  field?: readonly string[] | null;
  message: string;
  code?: string | null;
}

export class UserErrorsError extends Error {
  readonly operation: string;
  readonly userErrors: readonly ShopifyUserError[];

  constructor(operation: string, userErrors: readonly ShopifyUserError[]) {
    super(`"${operation}" returned userErrors: ${formatUserErrors(userErrors)}`);
    this.name = 'UserErrorsError';
    this.operation = operation;
    this.userErrors = userErrors;
  }
}

export function formatUserErrors(errors: readonly ShopifyUserError[]): string {
  return errors.map(formatUserError).join('; ');
}

export function formatUserError(error: ShopifyUserError): string {
  const path = error.field?.length ? `${error.field.join('.')}: ` : '';
  const code = error.code ? ` [${error.code}]` : '';
  return `${path}${error.message}${code}`;
}

export interface AssertUserErrorsOptions {
  /**
   * Error codes that mean "the outcome you wanted is already true".
   *
   * The install step is run again on every re-install and on demand, so
   * `TAKEN` on a definition that already exists is the expected result of a
   * second run, not a failure. Tolerated errors are returned rather than
   * dropped, so a caller can still report what it skipped.
   */
  tolerate?: readonly string[];
}

/**
 * Throw unless every `userError` is one the caller declared harmless.
 *
 * @returns the tolerated errors, in the order Shopify returned them.
 */
export function assertNoUserErrors(
  operation: string,
  userErrors: readonly ShopifyUserError[] | undefined | null,
  options: AssertUserErrorsOptions = {},
): readonly ShopifyUserError[] {
  if (!userErrors || userErrors.length === 0) return [];

  const tolerated = options.tolerate ?? [];
  const fatal = userErrors.filter(
    (error) => !error.code || !tolerated.includes(error.code),
  );

  if (fatal.length > 0) {
    throw new UserErrorsError(operation, fatal);
  }

  return userErrors;
}
