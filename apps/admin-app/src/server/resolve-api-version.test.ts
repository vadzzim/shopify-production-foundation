import { ApiVersion } from '@shopify/shopify-api';
import { ADMIN_API_VERSION } from '@nordlys/shared';
import { describe, expect, it } from 'vitest';

import { resolveApiVersion } from './resolve-api-version';

describe('resolveApiVersion', () => {
  it('accepts the pinned version, so the SDK and ADR-0009 agree', () => {
    // This is the assertion that would fail after an SDK upgrade that dropped
    // 2026-07. Without it, the mismatch would not be an error at all: Shopify
    // serves a request for an inaccessible version using the oldest accessible
    // one, and only a response header nobody reads says so.
    expect(resolveApiVersion()).toBe(ADMIN_API_VERSION);
    expect(Object.values(ApiVersion)).toContain(ADMIN_API_VERSION);
  });

  it('refuses a version the SDK does not know, and names the alternatives', () => {
    try {
      resolveApiVersion('2019-04');
      expect.unreachable('resolveApiVersion should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('2019-04');
      expect((error as Error).message).toContain('ADR-0009');
    }
  });

  it('refuses "latest", which is a documentation URL and not an API version', () => {
    expect(() => resolveApiVersion('latest')).toThrow();
  });

  it('does not police policy — only what the SDK supports', () => {
    // `unstable` is a version the SDK knows, so this function accepts it.
    // Ruling it out is ADR-0009's job, and the constant is where that decision
    // lives; duplicating the policy here would give it two homes to drift
    // between.
    expect(resolveApiVersion('unstable')).toBe('unstable');
  });
});
