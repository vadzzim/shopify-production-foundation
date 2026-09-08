import { describe, expect, it } from 'vitest';

import {
  assertNoUserErrors,
  formatUserError,
  UserErrorsError,
} from './user-errors';

describe('assertNoUserErrors', () => {
  it('passes an empty list through', () => {
    expect(assertNoUserErrors('op', [])).toEqual([]);
    expect(assertNoUserErrors('op', undefined)).toEqual([]);
  });

  it('throws when a mutation reported an error, however healthy the response looked', () => {
    // The response was HTTP 200 with no `errors`. This array is the only sign
    // that nothing was applied.
    expect(() =>
      assertNoUserErrors('metafieldDefinitionCreate', [
        { field: ['key'], message: 'is invalid', code: 'INVALID' },
      ]),
    ).toThrow(UserErrorsError);
  });

  it('keeps the errors on the exception rather than folding them into a string', () => {
    try {
      assertNoUserErrors('op', [{ message: 'nope', code: 'INVALID' }]);
      expect.unreachable('assertNoUserErrors should have thrown');
    } catch (error) {
      expect((error as UserErrorsError).userErrors).toEqual([
        { message: 'nope', code: 'INVALID' },
      ]);
      expect((error as UserErrorsError).operation).toBe('op');
    }
  });

  it('tolerates the codes a caller declared harmless, and returns them', () => {
    const tolerated = assertNoUserErrors(
      'op',
      [{ message: 'taken', code: 'TAKEN' }],
      { tolerate: ['TAKEN'] },
    );

    expect(tolerated).toEqual([{ message: 'taken', code: 'TAKEN' }]);
  });

  it('still throws when one error in a batch is not tolerated', () => {
    expect(() =>
      assertNoUserErrors(
        'op',
        [
          { message: 'taken', code: 'TAKEN' },
          { message: 'limit reached', code: 'LIMIT_EXCEEDED' },
        ],
        { tolerate: ['TAKEN'] },
      ),
    ).toThrow(/LIMIT_EXCEEDED/);
  });

  it('never tolerates an error with no code', () => {
    // A tolerance list matches on codes. An entry without one cannot be
    // recognised as harmless, so it is treated as a failure.
    expect(() =>
      assertNoUserErrors('op', [{ message: 'something' }], {
        tolerate: ['TAKEN'],
      }),
    ).toThrow(UserErrorsError);
  });
});

describe('formatUserError', () => {
  it('keeps the field path, the message and the code', () => {
    expect(
      formatUserError({
        field: ['definition', 'namespace'],
        message: 'Namespace is reserved',
        code: 'RESERVED_NAMESPACE_KEY',
      }),
    ).toBe('definition.namespace: Namespace is reserved [RESERVED_NAMESPACE_KEY]');
  });

  it('reads sensibly when Shopify sends neither field nor code', () => {
    expect(formatUserError({ message: 'Not permitted' })).toBe('Not permitted');
  });
});
