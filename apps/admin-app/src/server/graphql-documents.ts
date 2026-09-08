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

/**
 * One product's routine step, for the `products/update` reconciliation.
 *
 * A single product by id rather than a page of them: the webhook already says
 * which product changed, so paginating the catalog to find it would be one call
 * per page to answer a question the payload asked about one row. `product`
 * returns null for a product the token can no longer see, which is the deleted
 * case and is handled rather than treated as an error.
 */
export const PRODUCT_ROUTINE_STEP = /* GraphQL */ `
  query ProductRoutineStep($id: ID!) {
    product(id: $id) {
      id
      title
      status
      routineStep: metafield(namespace: "custom", key: "routine_step") {
        value
      }
    }
  }
`;

/**
 * Set on-hand stock for one or more InventoryItem × Location pairs.
 *
 * Three things about this document are not obvious and were confirmed against
 * the 2026-07 schema through the Shopify Dev MCP rather than written from
 * memory (ADR-0017 records the choice):
 *
 * **It is not `inventorySetOnHandQuantities`.** That mutation still exists in
 * 2026-07 and is marked deprecated in it, in favour of this one. Writing new
 * code against a mutation Shopify has already deprecated buys a rewrite at the
 * next upgrade for nothing.
 *
 * **`name` selects which quantity is being written.** `"on_hand"` is physical
 * stock; `"available"` is what a storefront may sell, which Shopify derives
 * from on-hand minus commitments. An integration that sets `available`
 * overwrites Shopify's own arithmetic about reserved units.
 *
 * **`@idempotent` is required.** Since 2026-04 this mutation refuses a request
 * without an idempotency key. That is not a burden here but the point: the key
 * is the job id, so a queue retry after an ambiguous failure re-sends the same
 * write and Shopify applies it once.
 */
export const SET_INVENTORY_ON_HAND = /* GraphQL */ `
  mutation SetInventoryOnHand(
    $input: InventorySetQuantitiesInput!
    $idempotencyKey: String!
  ) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryAdjustmentGroup {
        createdAt
        reason
        referenceDocumentUri
        changes {
          name
          delta
          quantityAfterChange
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;
