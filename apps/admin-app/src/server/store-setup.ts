import {
  ROUTINE_STEPS,
  type DefinitionResult,
  type StoreSetupReport,
} from '@nordlys/shared';

import { unwrap, type AdminGraphql } from './admin-graphql';
import {
  CREATE_METAFIELD_DEFINITION,
  CREATE_METAOBJECT_DEFINITION,
  METAOBJECT_DEFINITION_BY_TYPE,
} from './graphql-documents';
import { createThrottleGate, type ThrottleGateOptions } from './throttle';
import {
  assertNoUserErrors,
  formatUserErrors,
  type ShopifyUserError,
} from './user-errors';

/**
 * The app prepares the store itself.
 *
 * A merchant installing this app should not first have to build two metafield
 * definitions and a metaobject definition by hand in Settings -> Custom data.
 * The theme's sections read `custom.routine_step` and `custom.ingredients`
 * (ADR-0003), so on a store without them the storefront renders empty with no
 * error anywhere - the most expensive kind of failure to diagnose. Creating
 * them here makes a clean store a supported starting point.
 *
 * The step is idempotent. It runs after every OAuth, and the merchant can run
 * it again from the app, so "already exists" is an expected outcome and not a
 * failure: Shopify reports it as the `TAKEN` user error code, which is
 * tolerated and reported as `already_present`.
 */

/** Error codes that mean the definition is already in place. */
const ALREADY_PRESENT = ['TAKEN', 'UNSTRUCTURED_ALREADY_EXISTS'];

export const INGREDIENT_METAOBJECT_TYPE = 'ingredient';

const INGREDIENT_DEFINITION = {
  type: INGREDIENT_METAOBJECT_TYPE,
  name: 'Ingredient',
  // Without this the admin lists entries as "ingredient-1", which makes the
  // reference picker on a product unusable.
  displayNameKey: 'name',
  // Storefront access is what lets Liquid resolve the reference list to whole
  // objects. Missing it produces an empty section and no error at all.
  access: { storefront: 'PUBLIC_READ' },
  fieldDefinitions: [
    {
      key: 'name',
      name: 'Name',
      type: 'single_line_text_field',
      required: true,
    },
    {
      key: 'description',
      name: 'Description',
      type: 'multi_line_text_field',
      required: true,
    },
    {
      key: 'benefit',
      name: 'Benefit',
      type: 'single_line_text_field',
      required: true,
    },
    {
      key: 'image',
      name: 'Image',
      type: 'file_reference',
      required: false,
      validations: [{ name: 'file_type_options', value: '["Image"]' }],
    },
  ],
};

interface MetafieldDefinitionInput {
  name: string;
  namespace: string;
  key: string;
  description: string;
  type: string;
  ownerType: 'PRODUCT';
  pin: boolean;
  access: { storefront: 'PUBLIC_READ' };
  capabilities?: { smartCollectionCondition: { enabled: boolean } };
  validations?: { name: string; value: string }[];
}

function metafieldDefinitions(
  ingredientDefinitionId: string,
): MetafieldDefinitionInput[] {
  return [
    {
      name: 'Routine step',
      namespace: 'custom',
      key: 'routine_step',
      description:
        'Which step of the skincare routine this product belongs to.',
      type: 'single_line_text_field',
      ownerType: 'PRODUCT',
      pin: true,
      access: { storefront: 'PUBLIC_READ' },
      // The three routine collections are automated collections with a
      // condition on this metafield, and a metafield can only be used as a
      // collection condition when its definition says so.
      capabilities: { smartCollectionCondition: { enabled: true } },
      // The choice list is the validation. Keeping the allowed values in the
      // platform rather than in Liquid is what lets the theme compare strings
      // directly instead of normalising merchant input.
      validations: [
        { name: 'choices', value: JSON.stringify([...ROUTINE_STEPS]) },
      ],
    },
    {
      name: 'Ingredients',
      namespace: 'custom',
      key: 'ingredients',
      description:
        'Ingredients highlighted on the product page, in display order.',
      type: 'list.metaobject_reference',
      ownerType: 'PRODUCT',
      pin: true,
      access: { storefront: 'PUBLIC_READ' },
      validations: [
        { name: 'metaobject_definition_id', value: ingredientDefinitionId },
      ],
    },
  ];
}

// DefinitionResult and StoreSetupReport are the wire contract with the screen,
// so they live in @nordlys/shared next to the zod schema that parses them.

interface MetaobjectDefinitionByTypeData {
  metaobjectDefinitionByType: { id: string } | null;
}

interface CreateMetaobjectDefinitionData {
  metaobjectDefinitionCreate: {
    metaobjectDefinition: { id: string } | null;
    userErrors: ShopifyUserError[];
  };
}

interface CreateMetafieldDefinitionData {
  metafieldDefinitionCreate: {
    createdDefinition: { id: string } | null;
    userErrors: ShopifyUserError[];
  };
}

/**
 * Create the definitions the theme depends on, unless they are already there.
 *
 * Throws `UserErrorsError` for any `userErrors` entry that is not an "already
 * exists" code, and `AdminApiError` for transport or query failures. Nothing is
 * swallowed: a definition that failed to apply has to reach the merchant,
 * because the storefront symptom of a missing definition is an empty section
 * rather than an error.
 */
export async function ensureStoreDefinitions(
  graphql: AdminGraphql,
  throttleOptions: ThrottleGateOptions = {},
): Promise<StoreSetupReport> {
  const gate = createThrottleGate(throttleOptions);
  const results: DefinitionResult[] = [];

  // Rule 4: this is a loop of Admin API calls, so every response feeds the
  // throttle gate and the next call waits when the bucket cannot afford it.
  const run = async <T>(
    operation: string,
    document: string,
    variables: Record<string, unknown>,
  ): Promise<T> => {
    await gate.beforeCall();
    const response = await graphql<T>(document, variables);
    gate.record(response.extensions?.cost);
    return unwrap(operation, response);
  };

  // The ingredient metaobject definition comes first: the `custom.ingredients`
  // metafield validates against its id, so the metafield cannot be created
  // before the metaobject exists. This ordering is the "two definitions, and
  // they must be created in order" cost ADR-0003 accepted.
  const existing = await run<MetaobjectDefinitionByTypeData>(
    'metaobjectDefinitionByType',
    METAOBJECT_DEFINITION_BY_TYPE,
    { type: INGREDIENT_METAOBJECT_TYPE },
  );

  let ingredientDefinitionId = existing.metaobjectDefinitionByType?.id;

  if (ingredientDefinitionId) {
    results.push({
      definition: `metaobject:${INGREDIENT_METAOBJECT_TYPE}`,
      outcome: 'already_present',
    });
  } else {
    const created = await run<CreateMetaobjectDefinitionData>(
      'metaobjectDefinitionCreate',
      CREATE_METAOBJECT_DEFINITION,
      { definition: INGREDIENT_DEFINITION },
    );

    const tolerated = assertNoUserErrors(
      'metaobjectDefinitionCreate',
      created.metaobjectDefinitionCreate.userErrors,
      { tolerate: ALREADY_PRESENT },
    );

    ingredientDefinitionId =
      created.metaobjectDefinitionCreate.metaobjectDefinition?.id;

    if (!ingredientDefinitionId) {
      // Tolerated "already taken" with no definition in the payload: something
      // else created it between the query and the mutation. Read it back rather
      // than guess, because the metafield definition below needs its real id.
      const reread = await run<MetaobjectDefinitionByTypeData>(
        'metaobjectDefinitionByType',
        METAOBJECT_DEFINITION_BY_TYPE,
        { type: INGREDIENT_METAOBJECT_TYPE },
      );
      ingredientDefinitionId = reread.metaobjectDefinitionByType?.id;
    }

    if (!ingredientDefinitionId) {
      throw new Error(
        `The ${INGREDIENT_METAOBJECT_TYPE} metaobject definition was neither ` +
          `created nor found. Shopify reported: ${
            formatUserErrors(tolerated) || 'nothing'
          }.`,
      );
    }

    results.push({
      definition: `metaobject:${INGREDIENT_METAOBJECT_TYPE}`,
      outcome: tolerated.length > 0 ? 'already_present' : 'created',
      ...(tolerated.length > 0 ? { note: formatUserErrors(tolerated) } : {}),
    });
  }

  for (const definition of metafieldDefinitions(ingredientDefinitionId)) {
    const name = `${definition.namespace}.${definition.key}`;

    const created = await run<CreateMetafieldDefinitionData>(
      'metafieldDefinitionCreate',
      CREATE_METAFIELD_DEFINITION,
      { definition },
    );

    const tolerated = assertNoUserErrors(
      `metafieldDefinitionCreate(${name})`,
      created.metafieldDefinitionCreate.userErrors,
      { tolerate: ALREADY_PRESENT },
    );

    results.push({
      definition: name,
      outcome: tolerated.length > 0 ? 'already_present' : 'created',
      ...(tolerated.length > 0 ? { note: formatUserErrors(tolerated) } : {}),
    });
  }

  return { results, throttleWaitMs: gate.waitedMs() };
}
