/**
 * Every Admin GraphQL document the app sends.
 *
 * They live together because they are versioned together: each one is valid
 * against `ADMIN_API_VERSION` and nothing else (ADR-0009). All of them were
 * checked against the 2026-07 schema with the Shopify Dev MCP's
 * `validate_graphql_codeblocks` rather than written from memory, which is the
 * rule for this repository — a field that does not exist fails at runtime, on a
 * live store, with a message about a null result rather than a typo.
 */

export const METAOBJECT_DEFINITION_BY_TYPE = /* GraphQL */ `
  query MetaobjectDefinitionByType($type: String!) {
    metaobjectDefinitionByType(type: $type) {
      id
      type
      name
    }
  }
`;

export const CREATE_METAOBJECT_DEFINITION = /* GraphQL */ `
  mutation CreateMetaobjectDefinition(
    $definition: MetaobjectDefinitionCreateInput!
  ) {
    metaobjectDefinitionCreate(definition: $definition) {
      metaobjectDefinition {
        id
        type
        name
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export const CREATE_METAFIELD_DEFINITION = /* GraphQL */ `
  mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id
        name
        namespace
        key
        ownerType
      }
      userErrors {
        field
        message
        code
        elementKey
      }
    }
  }
`;

/**
 * Active products with their routine step, one page at a time.
 *
 * The step is read as a field rather than used as a search filter on purpose:
 * filtering products by a metafield in `query:` requires the definition to have
 * the admin-filterable capability, which this store's definition deliberately
 * does not have. Asking for a filter the definition cannot serve returns
 * everything, silently — so the grouping happens in the caller.
 *
 * `pageInfo` is selected because that grouping needs to know whether it has
 * seen the whole catalog. Without it, a step that first appears on product 150
 * looks identical to a step no product has, and the app would tell the merchant
 * their catalog is missing something it is not.
 */
export const ROUTINE_STEP_PRODUCTS = /* GraphQL */ `
  query RoutineStepProducts($first: Int!, $query: String, $after: String) {
    products(first: $first, query: $query, after: $after) {
      nodes {
        id
        title
        status
        routineStep: metafield(namespace: "custom", key: "routine_step") {
          value
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/**
 * The products referenced by the bundles on screen.
 *
 * `nodes(ids:)` returns `null` in place of anything the app can no longer see —
 * a deleted product, or one the current token has no access to. That null is
 * the signal the bundle list renders as "no longer in the catalog", so it is
 * kept rather than filtered out here.
 */
export const BUNDLE_PRODUCTS = /* GraphQL */ `
  query BundleProducts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        status
        routineStep: metafield(namespace: "custom", key: "routine_step") {
          value
        }
      }
    }
  }
`;
