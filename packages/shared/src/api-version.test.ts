import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ADMIN_API_VERSION } from './api-version';

const repositoryRoot = new URL('../../../', import.meta.url);

/**
 * These tests guard rule 1 of `CLAUDE.md`: the Admin API version lives in one
 * constant, and nowhere else. They are cheap, and the failure they prevent is
 * expensive — a version mismatch is served rather than rejected, so it shows up
 * as wrong data weeks later instead of as an error.
 */
describe('ADMIN_API_VERSION', () => {
  it('is the version ADR-0009 pins', () => {
    expect(ADMIN_API_VERSION).toBe('2026-07');
  });

  it('is a date-based version, not a channel name', () => {
    // `unstable` and `2026-10` would both be accepted by the API and are both
    // refused by ADR-0009: a release candidate takes backwards-incompatible
    // changes without notice.
    expect(ADMIN_API_VERSION).toMatch(/^\d{4}-(01|04|07|10)$/);
  });

  it('matches the webhook API version in shopify.app.toml', () => {
    // The one place the version is necessarily duplicated: TOML cannot import a
    // TypeScript constant, and Shopify CLI needs `[webhooks] api_version` in
    // the app config. A webhook registered at a different version than the code
    // parsing its payload is the same bug as a mismatched query, arriving
    // through a different door — so the duplication is guarded rather than
    // trusted.
    const toml = readFileSync(
      fileURLToPath(new URL('shopify.app.toml', repositoryRoot)),
      'utf8',
    );

    const match = /^\s*api_version\s*=\s*"([^"]+)"/m.exec(toml);

    expect(match?.[1]).toBe(ADMIN_API_VERSION);
  });

  it('does not appear as an environment variable in .env.example', () => {
    // ADR-0009, decision 2: making the version deployment configuration creates
    // a combination — old GraphQL documents, new version — that nothing
    // typechecks and nothing tests.
    const example = readFileSync(
      fileURLToPath(new URL('.env.example', repositoryRoot)),
      'utf8',
    );

    const assignments = example
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .filter((line) => /API_VERSION\s*=/.test(line));

    expect(assignments).toEqual([]);
  });
});
