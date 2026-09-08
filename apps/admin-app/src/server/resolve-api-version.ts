import { ApiVersion } from '@shopify/shopify-api';
import { ADMIN_API_VERSION } from '@nordlys/shared';

/**
 * Turn the pinned version constant into the SDK's `ApiVersion` value, refusing
 * to start if the SDK does not know it.
 *
 * The cast this replaces would compile. The check exists because of how Shopify
 * fails: a request to a version that is no longer accessible is not rejected -
 * it is served with the oldest accessible stable version instead, and the only
 * evidence is a response header nothing reads. So an SDK upgrade that drops
 * `2026-07` would otherwise show up as subtly wrong data weeks later. Here it
 * shows up as a start-up error naming the versions the SDK does support.
 */
export function resolveApiVersion(version: string = ADMIN_API_VERSION): ApiVersion {
  const supported = Object.values(ApiVersion) as string[];

  if (!supported.includes(version)) {
    throw new Error(
      `Admin API version "${version}" is pinned in ` +
        `packages/shared/src/api-version.ts, but @shopify/shopify-api does not ` +
        `list it. Supported: ${supported.join(', ')}. Either the SDK dropped ` +
        `the version - in which case read ADR-0009 before changing the ` +
        `constant - or the constant has a typo.`,
    );
  }

  return version as ApiVersion;
}
