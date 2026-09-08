import { describe, expect, it } from 'vitest';

import { withCliAliases } from './cli-env-aliases';

/**
 * Worth a test because the failure it prevents is confusing rather than
 * obvious: `shopify app dev` supplies the tunnel URL as `HOST`, the app asks for
 * `SHOPIFY_APP_URL`, and the result is a start-up error naming a variable the
 * CLI had in fact provided under a different name.
 */
describe('withCliAliases', () => {
  it('reads the tunnel URL the CLI injects as HOST', () => {
    expect(
      withCliAliases({ HOST: 'https://x.trycloudflare.com' }),
    ).toMatchObject({ SHOPIFY_APP_URL: 'https://x.trycloudflare.com' });
  });

  it('accepts APP_URL too, since the CLI documents both names', () => {
    expect(
      withCliAliases({ APP_URL: 'https://x.trycloudflare.com' }),
    ).toMatchObject({ SHOPIFY_APP_URL: 'https://x.trycloudflare.com' });
  });

  it('maps SCOPES onto SHOPIFY_SCOPES', () => {
    expect(
      withCliAliases({ SCOPES: 'read_products,write_products' }),
    ).toMatchObject({ SHOPIFY_SCOPES: 'read_products,write_products' });
  });

  it('prefers this project’s name when both are set', () => {
    const resolved = withCliAliases({
      SHOPIFY_APP_URL: 'https://explicit.example.com',
      HOST: 'https://tunnel.example.com',
    });

    expect(resolved.SHOPIFY_APP_URL).toBe('https://explicit.example.com');
  });

  it('leaves an environment with no aliases untouched', () => {
    const source = { DATABASE_URL: 'postgresql://localhost:5432/nordlys' };

    expect(withCliAliases(source)).toEqual(source);
  });

  it('treats an alias that is set but empty as absent', () => {
    // An empty string from a shell is absence, not a value. Passing it through
    // would fail zod with a worse message than "Required".
    expect(withCliAliases({ HOST: '' }).SHOPIFY_APP_URL).toBeUndefined();
  });
});
