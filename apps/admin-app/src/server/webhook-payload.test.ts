import { describe, expect, it } from 'vitest';

import { storableBody } from './webhook-payload';

/**
 * What may be written to `Job.payload`.
 *
 * The assertions here are almost all negative, which is unusual and is the
 * point: the interesting failure is not a missing field — a handler falls over
 * loudly on that — but an *extra* one. A customer's email that survives the
 * projection is invisible in every test of behaviour and shows up two years
 * later in a database backup.
 */

/** An `orders/create` body cut down to the shape Shopify actually sends. */
const ORDER = {
  id: 820982911946154500,
  name: '#1001',
  email: 'ida.hansen@example.com',
  phone: '+4791234567',
  customer: {
    id: 115310627314,
    first_name: 'Ida',
    last_name: 'Hansen',
    email: 'ida.hansen@example.com',
  },
  billing_address: { address1: 'Storgata 1', city: 'Oslo', zip: '0155' },
  shipping_address: { address1: 'Storgata 1', city: 'Oslo', zip: '0155' },
  total_price: '899.00',
  line_items: [
    {
      id: 1,
      title: 'Barrier Serum',
      properties: [
        { name: '_bundle_id', value: 'bundle-1' },
        { name: 'Gift message', value: 'Happy birthday, love from Ida' },
      ],
    },
  ],
};

describe('storableBody', () => {
  describe('orders/create', () => {
    it('keeps the bundle link and the order name', async () => {
      expect(storableBody('orders/create', ORDER)).toEqual({
        name: '#1001',
        line_items: [
          { properties: [{ name: '_bundle_id', value: 'bundle-1' }] },
        ],
      });
    });

    it('drops everything that identifies the person who ordered', () => {
      const stored = JSON.stringify(storableBody('orders/create', ORDER));

      for (const trace of [
        'ida.hansen@example.com',
        '+4791234567',
        'Hansen',
        'Storgata 1',
        '115310627314',
      ]) {
        expect(stored).not.toContain(trace);
      }
    });

    it('drops line item properties other than the bundle id', () => {
      // Line item properties are storefront-written and can carry anything a
      // merchant put a text field in front of.
      const stored = JSON.stringify(storableBody('orders/create', ORDER));

      expect(stored).not.toContain('Gift message');
      expect(stored).not.toContain('Happy birthday');
    });
  });

  describe('the customer topics', () => {
    it('keeps the ids a data request is about and not the email', () => {
      const stored = storableBody('customers/data_request', {
        shop_domain: 'nordlys.myshopify.com',
        customer: { id: 191167, email: 'ida.hansen@example.com' },
        orders_requested: [299938, 280948],
        data_request: { id: 9999 },
      });

      expect(stored).toEqual({
        customer: { id: 191167 },
        data_request: { id: 9999 },
        orders_requested: [299938, 280948],
      });
    });

    it('keeps only the customer id on a redaction request', () => {
      // The id has to stay: it is what the redaction handler matches the
      // earlier requests about the same person against. The email does not.
      expect(
        storableBody('customers/redact', {
          shop_domain: 'nordlys.myshopify.com',
          customer: { id: 191167, email: 'ida.hansen@example.com' },
          orders_to_redact: [299938],
        }),
      ).toEqual({ customer: { id: 191167 } });
    });
  });

  it('stores nothing at all for the shop-scoped topics', () => {
    // Both handlers work from `job.shop`, which comes from the verified header.
    expect(storableBody('app/uninstalled', { id: 1, domain: 'x.myshopify.com' })).toEqual({});
    expect(storableBody('shop/redact', { shop_id: 1, shop_domain: 'x' })).toEqual({});
  });

  it('keeps both product identifiers, since either may be missing', () => {
    expect(
      storableBody('products/update', {
        id: 788032119674292900,
        admin_graphql_api_id: 'gid://shopify/Product/788032119674292900',
        title: 'Barrier Serum',
        body_html: '<p>…</p>',
      }),
    ).toEqual({
      id: 788032119674292900,
      admin_graphql_api_id: 'gid://shopify/Product/788032119674292900',
    });
  });

  it('refuses a field that arrives as an object where a scalar was expected', () => {
    // The guard against a payload growing a nested shape under a name that used
    // to be flat, and smuggling the contents past the projection.
    expect(
      storableBody('products/update', {
        id: { value: 1, note: 'ida.hansen@example.com' },
      }),
    ).toEqual({});
  });

  it('survives a body that is not an object', () => {
    // A verified delivery whose body is an array or a string is Shopify sending
    // something this code does not know, and the router must still answer 200
    // and let the handler fail the job. A throw here would be a 500 and five
    // redeliveries of the same unusable body.
    expect(storableBody('orders/create', ['not', 'an', 'object'])).toEqual({
      line_items: [],
    });
    expect(storableBody('customers/redact', null)).toEqual({ customer: {} });
  });
});
