import { describe, expect, it } from 'vitest';

import { bundleUpdateSchema } from './bundle';

/**
 * The edit request, checked at the boundary.
 *
 * This schema is the only thing standing between a request body and a
 * transaction that rewrites a routine set, so what it rejects matters more than
 * what it accepts. Each case below is a shape that would otherwise reach the
 * database and either violate a constraint there — further from the cause, with
 * a worse message — or be stored and render a set the storefront cannot fill.
 */

const CLEANSE = { productGid: 'gid://shopify/Product/1', routineStep: 'cleanse' };
const TREAT = { productGid: 'gid://shopify/Product/2', routineStep: 'treat' };
const MOISTURIZE = {
  productGid: 'gid://shopify/Product/3',
  routineStep: 'moisturize',
};

describe('bundleUpdateSchema', () => {
  it('accepts a full set of three steps', () => {
    const parsed = bundleUpdateSchema.safeParse({
      title: 'Nordic winter routine',
      status: 'active',
      items: [CLEANSE, TREAT, MOISTURIZE],
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts a change to the title alone', () => {
    expect(bundleUpdateSchema.safeParse({ title: 'Renamed' }).success).toBe(
      true,
    );
  });

  it('rejects a request that changes nothing', () => {
    // Answering 200 to this would tell the caller a change was applied.
    expect(bundleUpdateSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a title that is only whitespace', () => {
    const parsed = bundleUpdateSchema.safeParse({ title: '   ' });
    expect(parsed.success).toBe(false);
  });

  it('trims the title it accepts', () => {
    const parsed = bundleUpdateSchema.parse({ title: '  Renamed  ' });
    expect(parsed.title).toBe('Renamed');
  });

  it('rejects a set with a missing step', () => {
    const parsed = bundleUpdateSchema.safeParse({ items: [CLEANSE, TREAT] });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('moisturize');
  });

  it('rejects a set that uses one step twice', () => {
    const parsed = bundleUpdateSchema.safeParse({
      items: [CLEANSE, TREAT, { ...MOISTURIZE, routineStep: 'treat' }],
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('treat');
  });

  it('rejects the same product in two steps', () => {
    // A product carries one `custom.routine_step` value, so such a set could
    // never be activated.
    const parsed = bundleUpdateSchema.safeParse({
      items: [CLEANSE, TREAT, { ...MOISTURIZE, productGid: CLEANSE.productGid }],
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('more than one step');
  });

  it('rejects an id that is not a product gid', () => {
    // A variant gid is the plausible mistake, and it resolves to null rather
    // than to an error when handed to `nodes(ids:)`.
    const parsed = bundleUpdateSchema.safeParse({
      items: [
        { productGid: 'gid://shopify/ProductVariant/1', routineStep: 'cleanse' },
        TREAT,
        MOISTURIZE,
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects a status the database has no column value for', () => {
    expect(
      bundleUpdateSchema.safeParse({ status: 'published' }).success,
    ).toBe(false);
  });
});
