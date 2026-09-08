import type { WebhookTopic } from '@nordlys/shared';

/**
 * What of a webhook delivery is allowed into the database.
 *
 * A webhook body is far larger than the handler that reads it: an
 * `orders/create` delivery carries the customer's name, email, phone and both
 * addresses, and `customers/redact` carries the email of the person asking to
 * be forgotten. Storing the body verbatim in `Job.payload` puts all of that in
 * a `jsonb` column that outlives the job, is read back by the sync log, and is
 * dumped into any database backup — while the handlers between them read an
 * order name, a product id and a handful of line item properties.
 *
 * So the delivery is projected onto exactly the fields a handler needs before
 * it is written, and the rest is dropped at the door. Two reasons that is the
 * right place for it rather than a cleanup pass later:
 *
 * - Data never stored needs no redaction. `customers/redact` and `shop/redact`
 *   can only erase what they know about, and a column that never held an email
 *   cannot be missed by a `deleteMany`.
 * - It keeps the claim in `job-handlers.ts` true. That comment says this
 *   database holds no customer personal data, which is what makes
 *   `customers/data_request` a genuine no-op rather than an unimplemented one.
 *   Before this projection existed the claim was wrong: the order payload was
 *   sitting in the queue.
 *
 * The mapping is a total `Record` over the topic union rather than a `switch`
 * with a default, for the same reason `JOB_KIND_BY_TOPIC` is: subscribing to a
 * new topic should not silently inherit "store the whole body". It should fail
 * to compile until someone decides what of it may be kept.
 */

/**
 * The line item property the theme's bundle-builder writes (ADR-0012).
 *
 * Exported because two places have to agree on it: the projection below, which
 * keeps this property and discards every other one, and the order handler,
 * which reads it. Spelled differently in one of them, orders would arrive with
 * their bundle link already stripped.
 */
export const BUNDLE_ID_PROPERTY = '_bundle_id';

/** A JSON object, as it comes out of `JSON.parse`. */
type Body = Record<string, unknown>;

function asRecord(value: unknown): Body {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Body)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Copy `key` from `source` if it holds a primitive worth keeping.
 *
 * Objects and arrays are refused rather than copied: this is the guard against
 * a field that looks scalar in the payloads seen so far and one day arrives as
 * a nested object carrying more than the name suggested.
 */
function scalar(source: Body, key: string): Body {
  const value = source[key];
  const keep =
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean';

  return keep ? { [key]: value } : {};
}

/**
 * The bundle ids an order's line items claim, as line item properties.
 *
 * Only the bundle property survives. The others are the storefront's to write
 * and can carry anything a merchant put a text field in front of — an engraving
 * message, a gift note, a delivery instruction — which is customer content this
 * app has no reason to keep.
 */
function bundleProperties(body: Body): Body {
  const lineItems = asArray(body.line_items).map((item) => {
    const properties = asArray(asRecord(item).properties)
      .map(asRecord)
      .filter((property) => property.name === BUNDLE_ID_PROPERTY)
      .map((property) => ({
        name: BUNDLE_ID_PROPERTY,
        ...scalar(property, 'value'),
      }));

    return { properties };
  });

  return { line_items: lineItems };
}

const PROJECTIONS: Record<WebhookTopic, (body: Body) => Body> = {
  // The handler needs the bundle ids and, for its log lines, the order name —
  // which is the `#1001` a merchant can find the order by. Everything else the
  // order carries about the person who placed it is dropped, including the
  // `customer` object, both addresses and the totals.
  'orders/create': (body) => ({
    ...scalar(body, 'name'),
    ...bundleProperties(body),
  }),
  // Which product changed. The handler reads the step back from the Admin API
  // rather than from the payload, so nothing else here is used.
  'products/update': (body) => ({
    ...scalar(body, 'id'),
    ...scalar(body, 'admin_graphql_api_id'),
  }),
  // Nothing: the handler works entirely from `job.shop`, which comes from the
  // verified header rather than the body.
  'app/uninstalled': () => ({}),
  // The identifiers the request is about, so that answering it can be shown to
  // have happened. Not the email — Shopify sends it, and this app has no use
  // for it that would survive being asked why it was kept.
  'customers/data_request': (body) => ({
    customer: scalar(asRecord(body.customer), 'id'),
    data_request: scalar(asRecord(body.data_request), 'id'),
    orders_requested: asArray(body.orders_requested).filter(
      (id) => typeof id === 'number',
    ),
  }),
  'customers/redact': (body) => ({
    customer: scalar(asRecord(body.customer), 'id'),
  }),
  // Nothing, again from `job.shop`. This job also deletes the rest of the
  // shop's rows, so anything kept here would be the one thing to survive the
  // erasure it performs.
  'shop/redact': () => ({}),
};

/**
 * The part of a verified delivery that may be persisted.
 *
 * Takes the parsed body as `unknown` because that is what `JSON.parse` promises
 * and a projection has to cope with a shape it did not expect: a body that is
 * an array, a null, or a string is projected to an empty object, and the
 * handler then fails the job on a payload it cannot use — which is the right
 * outcome and a better one than a crash in the router before the 200.
 */
export function storableBody(topic: WebhookTopic, body: unknown): Body {
  return PROJECTIONS[topic](asRecord(body));
}
