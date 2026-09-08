/**
 * The Admin API version every request in this repository targets.
 *
 * This is the single place the value exists. Not inline at call sites, not an
 * environment variable, and never taken from a model's memory — the reasoning
 * is in `docs/adr/0009-admin-api-version.md`, and the short form is:
 *
 * - The version is a *compile-time* compatibility contract. The GraphQL
 *   documents in this repository are written against the fields and mutations
 *   of one specific version, so making it configurable per environment creates
 *   a combination — old documents, new version — that nothing typechecks and
 *   nothing tests.
 * - Getting it wrong fails silently. A request to a version that is no longer
 *   accessible is not rejected; Shopify serves it with the oldest accessible
 *   stable version instead. The app keeps working until a behavioural
 *   difference produces wrong data, with nothing in the response to say why.
 *
 * Confirmed as the current stable version through the Shopify Dev MCP on
 * 2026-09-08: released 2026-07-01, accessible until 2027-07-16 15:00 UTC.
 * 2026-10 exists but is still a release candidate until 2026-10-01, and
 * release candidates take backwards-incompatible changes without notice.
 *
 * Upgrade trigger and deadline: ADR-0009. Webhook subscriptions carry their own
 * version and must be registered against this same constant — a webhook
 * registered at a different version than the code parsing its payload is the
 * same bug arriving through a different door.
 */
export const ADMIN_API_VERSION = '2026-07';

/** Literal type of {@link ADMIN_API_VERSION}, for signatures that pin it. */
export type AdminApiVersion = typeof ADMIN_API_VERSION;
