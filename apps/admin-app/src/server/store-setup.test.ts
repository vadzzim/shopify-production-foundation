import { describe, expect, it } from 'vitest';

import { AdminApiError, type AdminGraphql } from './admin-graphql';
import { ensureStoreDefinitions } from './store-setup';
import { UserErrorsError, type ShopifyUserError } from './user-errors';

const INGREDIENT_GID = 'gid://shopify/MetaobjectDefinition/1';

interface Call {
  document: string;
  variables: Record<string, unknown> | undefined;
}

/**
 * A fake Admin API.
 *
 * Fake rather than a live store because the interesting cases here are the ones
 * a happy store never produces: a `TAKEN` user error, an unexpected one, a
 * definition that vanishes between the read and the write. A test that needs a
 * store in each of those states is a test nobody runs.
 */
function fakeAdmin(
  responses: Record<string, unknown[]>,
): { graphql: AdminGraphql; calls: Call[] } {
  const calls: Call[] = [];
  const queues = new Map(
    Object.entries(responses).map(([key, list]) => [key, [...list]]),
  );

  const graphql: AdminGraphql = async (document, variables) => {
    calls.push({ document, variables });

    const key = [...queues.keys()].find((candidate) =>
      document.includes(candidate),
    );

    if (!key) throw new Error(`No fake response for document: ${document}`);

    const queue = queues.get(key)!;
    const next = queue.length > 1 ? queue.shift() : queue[0];

    return {
      data: next as never,
      extensions: {
        cost: {
          requestedQueryCost: 10,
          actualQueryCost: 10,
          throttleStatus: {
            maximumAvailable: 2000,
            currentlyAvailable: 1990,
            restoreRate: 100,
          },
        },
      },
    };
  };

  return { graphql, calls };
}

const noUserErrors: ShopifyUserError[] = [];

const metafieldCreated = {
  metafieldDefinitionCreate: {
    createdDefinition: { id: 'gid://shopify/MetafieldDefinition/1' },
    userErrors: noUserErrors,
  },
};

describe('ensureStoreDefinitions', () => {
  it('creates the metaobject definition before the metafields that reference it', async () => {
    const { graphql, calls } = fakeAdmin({
      MetaobjectDefinitionByType: [{ metaobjectDefinitionByType: null }],
      CreateMetaobjectDefinition: [
        {
          metaobjectDefinitionCreate: {
            metaobjectDefinition: { id: INGREDIENT_GID },
            userErrors: noUserErrors,
          },
        },
      ],
      CreateMetafieldDefinition: [metafieldCreated],
    });

    const report = await ensureStoreDefinitions(graphql, { sleep: async () => {} });

    expect(report.results.map((result) => result.definition)).toEqual([
      'metaobject:ingredient',
      'custom.routine_step',
      'custom.ingredients',
    ]);
    expect(report.results.every((result) => result.outcome === 'created')).toBe(
      true,
    );

    // The ingredients metafield validates against the metaobject definition's
    // id, so it can only be built once that id exists.
    const ingredientsCall = calls.find((call) => {
      const definition = call.variables?.definition as
        | { key?: string }
        | undefined;
      return definition?.key === 'ingredients';
    });

    expect(ingredientsCall?.variables).toMatchObject({
      definition: {
        validations: [
          { name: 'metaobject_definition_id', value: INGREDIENT_GID },
        ],
      },
    });
  });

  it('skips creating the metaobject definition when the store already has it', async () => {
    const { graphql, calls } = fakeAdmin({
      MetaobjectDefinitionByType: [
        { metaobjectDefinitionByType: { id: INGREDIENT_GID } },
      ],
      CreateMetafieldDefinition: [metafieldCreated],
    });

    const report = await ensureStoreDefinitions(graphql, { sleep: async () => {} });

    expect(report.results[0]).toEqual({
      definition: 'metaobject:ingredient',
      outcome: 'already_present',
    });
    expect(
      calls.some((call) => call.document.includes('CreateMetaobjectDefinition')),
    ).toBe(false);
  });

  it('treats TAKEN as "already there", because the step runs again on every install', async () => {
    const { graphql } = fakeAdmin({
      MetaobjectDefinitionByType: [
        { metaobjectDefinitionByType: { id: INGREDIENT_GID } },
      ],
      CreateMetafieldDefinition: [
        {
          metafieldDefinitionCreate: {
            createdDefinition: null,
            userErrors: [
              { field: ['key'], message: 'Key is in use', code: 'TAKEN' },
            ],
          },
        },
      ],
    });

    const report = await ensureStoreDefinitions(graphql, { sleep: async () => {} });

    const routineStep = report.results.find(
      (result) => result.definition === 'custom.routine_step',
    );

    expect(routineStep?.outcome).toBe('already_present');
    expect(routineStep?.note).toContain('TAKEN');
  });

  it('throws on a user error that is not "already there"', async () => {
    // Rule 2: the mutation returned HTTP 200 and did not apply. Reporting
    // success here is the exact failure the rule exists to prevent.
    const { graphql } = fakeAdmin({
      MetaobjectDefinitionByType: [
        { metaobjectDefinitionByType: { id: INGREDIENT_GID } },
      ],
      CreateMetafieldDefinition: [
        {
          metafieldDefinitionCreate: {
            createdDefinition: null,
            userErrors: [
              {
                field: ['definition', 'validations'],
                message: 'Choices must be unique',
                code: 'DUPLICATE_OPTION',
              },
            ],
          },
        },
      ],
    });

    await expect(
      ensureStoreDefinitions(graphql, { sleep: async () => {} }),
    ).rejects.toThrow(UserErrorsError);
  });

  it('carries the userErrors through on the thrown error', async () => {
    const { graphql } = fakeAdmin({
      MetaobjectDefinitionByType: [
        { metaobjectDefinitionByType: { id: INGREDIENT_GID } },
      ],
      CreateMetafieldDefinition: [
        {
          metafieldDefinitionCreate: {
            createdDefinition: null,
            userErrors: [
              { field: null, message: 'Not permitted', code: 'INVALID' },
            ],
          },
        },
      ],
    });

    // The messages are the only description of what Shopify refused, so they
    // have to reach the merchant rather than being flattened into "failed".
    await expect(
      ensureStoreDefinitions(graphql, { sleep: async () => {} }),
    ).rejects.toMatchObject({
      userErrors: [{ message: 'Not permitted', code: 'INVALID' }],
    });
  });

  it('re-reads the definition when TAKEN comes back without one', async () => {
    // Something created it between our query and our mutation. The metafield
    // definition below needs the real id, so guessing is not an option.
    const { graphql } = fakeAdmin({
      MetaobjectDefinitionByType: [
        { metaobjectDefinitionByType: null },
        { metaobjectDefinitionByType: { id: INGREDIENT_GID } },
      ],
      CreateMetaobjectDefinition: [
        {
          metaobjectDefinitionCreate: {
            metaobjectDefinition: null,
            userErrors: [{ message: 'Type is in use', code: 'TAKEN' }],
          },
        },
      ],
      CreateMetafieldDefinition: [metafieldCreated],
    });

    const report = await ensureStoreDefinitions(graphql, { sleep: async () => {} });

    expect(report.results[0]?.outcome).toBe('already_present');
    expect(report.results).toHaveLength(3);
  });

  it('surfaces a transport failure rather than reporting an empty success', async () => {
    const graphql: AdminGraphql = async () => ({
      errors: { networkStatusCode: 503, message: 'Service Unavailable' },
    });

    await expect(
      ensureStoreDefinitions(graphql, { sleep: async () => {} }),
    ).rejects.toThrow(AdminApiError);
  });

  it('paces itself against the rate limit bucket', async () => {
    // Rule 4: a loop of Admin API calls reads throttleStatus and backs off.
    const waits: number[] = [];
    const graphql: AdminGraphql = async (document) => ({
      data: (document.includes('MetaobjectDefinitionByType')
        ? { metaobjectDefinitionByType: { id: INGREDIENT_GID } }
        : metafieldCreated) as never,
      extensions: {
        cost: {
          requestedQueryCost: 100,
          actualQueryCost: 100,
          throttleStatus: {
            maximumAvailable: 2000,
            currentlyAvailable: 0,
            restoreRate: 100,
          },
        },
      },
    });

    await ensureStoreDefinitions(graphql, {
      sleep: async (ms) => {
        waits.push(ms);
      },
      random: () => 0,
    });

    // Two waits: one before each metafield mutation. The first call has nothing
    // to go on yet, so it is never delayed.
    expect(waits).toEqual([1_000, 1_000]);
  });
});
