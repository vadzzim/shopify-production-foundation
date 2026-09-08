import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv } from './env';

const complete = {
  SHOPIFY_API_KEY: 'key',
  SHOPIFY_API_SECRET: 'secret',
  SHOPIFY_APP_URL: 'https://tunnel.example.com',
  SHOPIFY_SCOPES: 'read_products,write_products',
  SHOPIFY_STORE: 'ecorn-oj1cb5ll.myshopify.com',
  DATABASE_URL: 'postgresql://nordlys:nordlys@localhost:5432/nordlys',
} satisfies NodeJS.ProcessEnv;

describe('loadEnv', () => {
  it('accepts a complete environment and applies the documented defaults', () => {
    const env = loadEnv({ ...complete });

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('fails when a required variable is missing', () => {
    const { SHOPIFY_API_SECRET: _omitted, ...withoutSecret } = complete;

    expect(() => loadEnv(withoutSecret)).toThrow(EnvValidationError);
  });

  it('reports every problem at once, not just the first', () => {
    // A fresh checkout usually has several variables unset. Reporting one at a
    // time turns setup into a guessing game: fix, restart, discover the next.
    const {
      SHOPIFY_API_KEY: _key,
      SHOPIFY_API_SECRET: _secret,
      DATABASE_URL: _db,
      ...sparse
    } = complete;

    try {
      loadEnv(sparse);
      expect.unreachable('loadEnv should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const { issues } = error as EnvValidationError;

      expect(issues).toHaveLength(3);
      expect(issues.join('\n')).toContain('SHOPIFY_API_KEY');
      expect(issues.join('\n')).toContain('SHOPIFY_API_SECRET');
      expect(issues.join('\n')).toContain('DATABASE_URL');
    }
  });

  it('names the offending variable in the message', () => {
    // The whole point of validating at startup is a message that says what to
    // fix. "Invalid input" would fail just as early and help nobody.
    expect(() =>
      loadEnv({ ...complete, SHOPIFY_STORE: 'ecorn.example.com' }),
    ).toThrow(/SHOPIFY_STORE/);
  });

  it('rejects a plain-http app URL', () => {
    // The admin frames the app over HTTPS; an http app URL is refused by the
    // browser, which is a much harder failure to read than this one.
    expect(() =>
      loadEnv({ ...complete, SHOPIFY_APP_URL: 'http://tunnel.example.com' }),
    ).toThrow(/SHOPIFY_APP_URL/);
  });

  it('strips a trailing slash from the app URL', () => {
    // The value is concatenated with paths, so a trailing slash produces
    // callback URLs with a double slash that no longer match the app config.
    const env = loadEnv({
      ...complete,
      SHOPIFY_APP_URL: 'https://tunnel.example.com/',
    });

    expect(env.SHOPIFY_APP_URL).toBe('https://tunnel.example.com');
  });

  it('splits scopes into a list and drops incidental whitespace', () => {
    const env = loadEnv({
      ...complete,
      SHOPIFY_SCOPES: 'read_products, write_products ,read_orders',
    });

    expect(env.SHOPIFY_SCOPES).toEqual([
      'read_products',
      'write_products',
      'read_orders',
    ]);
  });

  it('rejects an empty scope list rather than requesting no scopes', () => {
    expect(() => loadEnv({ ...complete, SHOPIFY_SCOPES: ' , ' })).toThrow(
      EnvValidationError,
    );
  });

  it('coerces PORT, which arrives as a string from the environment', () => {
    expect(loadEnv({ ...complete, PORT: '8080' }).PORT).toBe(8080);
    expect(() => loadEnv({ ...complete, PORT: 'http' })).toThrow(
      EnvValidationError,
    );
  });
});
