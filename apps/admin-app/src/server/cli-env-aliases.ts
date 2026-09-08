/**
 * Shopify CLI's names for values this app already has names for.
 *
 * `shopify app dev` runs the app process itself and injects the app's
 * credentials, the tunnel URL and the scopes as `SHOPIFY_API_KEY`,
 * `SHOPIFY_API_SECRET`, `HOST` (also `APP_URL`), `SCOPES` and `PORT`. Two of
 * those this project calls something else, so without this mapping the app
 * refuses to start under the CLI with "SHOPIFY_APP_URL: Required" — while the
 * CLI had in fact supplied it.
 *
 * Mapped at the edge rather than in `packages/shared`: the schema is this
 * project's contract, and this is where another tool's convention meets it.
 *
 * A separate module from `env.ts` so it can be tested. Importing `env.ts` runs
 * `loadEnv` at module load, by design (rule 5) — which means a test that
 * imported it would need a populated environment to exist.
 */
const CLI_ALIASES: Record<string, readonly string[]> = {
  SHOPIFY_APP_URL: ['HOST', 'APP_URL'],
  SHOPIFY_SCOPES: ['SCOPES'],
};

/**
 * Fill in this project's variable names from Shopify CLI's, where they are
 * missing.
 *
 * Our own names win when both are set, so an explicit `.env` still overrides.
 * Scopes especially must not come from two places at once: `[access_scopes]` in
 * `shopify.app.toml` is what the merchant actually granted, the CLI passes
 * exactly that as `SCOPES`, and a `.env` that disagrees puts the app in a
 * scope-update loop on every load.
 */
export function withCliAliases(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const resolved: NodeJS.ProcessEnv = { ...source };

  for (const [canonical, aliases] of Object.entries(CLI_ALIASES)) {
    if (resolved[canonical]) continue;

    const alias = aliases.find((name) => source[name]);
    if (alias) resolved[canonical] = source[alias];
  }

  return resolved;
}
