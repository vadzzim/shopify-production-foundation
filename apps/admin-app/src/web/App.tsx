import { useCallback, useEffect, useState } from 'react';
import { ROUTINE_STEPS, type Bundle, type RoutineStep } from '@nordlys/shared';

import {
  ApiRequestError,
  createStarterBundle,
  fetchBundles,
  prepareStore,
} from './api';

/**
 * The bundle index.
 *
 * Three states are treated as first-class rather than as edge cases, because
 * two of them are what a merchant actually meets first: a freshly installed app
 * has no bundles, and a store missing the metafield definitions cannot build
 * one. A screen that only renders the happy path leaves both of those looking
 * like a bug.
 *
 * The components are Polaris web components — custom elements registered by the
 * script in index.html, so there is nothing to import. Polaris React was the
 * other option and is now deprecated on npm ("no longer maintained", pointing
 * at these); see ADR-0015.
 */

type Screen =
  | { status: 'loading' }
  | { status: 'ready'; bundles: Bundle[] }
  | { status: 'failed'; error: ApiRequestError };

type PendingAction = 'starter' | 'prepare' | null;

function describeError(error: unknown): ApiRequestError {
  return error instanceof ApiRequestError
    ? error
    : new ApiRequestError(
        'Something unexpected went wrong in the app.',
        0,
        error instanceof Error ? [error.message] : [],
      );
}

/** Routine steps and bundle statuses are lower-case on the wire, matching the
 *  metafield's choice list and the Prisma enum. The admin shows them capitalised. */
function label(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * What one cell says about a step.
 *
 * `null` title means the Admin API returned no product for a GID we stored —
 * the product was deleted in Shopify. Showing the stale name would be a lie, so
 * the cell says so instead.
 */
function ProductCell({
  bundle,
  step,
}: {
  bundle: Bundle;
  step: RoutineStep;
}): React.JSX.Element {
  const item = bundle.items.find((candidate) => candidate.routineStep === step);

  if (!item) {
    return <s-text color="subdued">—</s-text>;
  }

  if (item.title === null) {
    return (
      <s-stack direction="inline" gap="small-300" alignItems="center">
        <s-badge tone="critical">Removed</s-badge>
        <s-text color="subdued">no longer in the catalog</s-text>
      </s-stack>
    );
  }

  return (
    <s-stack direction="inline" gap="small-300" alignItems="center">
      <s-text>{item.title}</s-text>
      {item.productStatus !== 'ACTIVE' && (
        <s-badge tone="warning">
          {item.productStatus === 'DRAFT' ? 'Draft' : 'Archived'}
        </s-badge>
      )}
    </s-stack>
  );
}

function ErrorBanner({
  error,
  onRetry,
}: {
  error: ApiRequestError;
  onRetry?: () => void;
}): React.JSX.Element {
  return (
    <s-banner heading="This did not work" tone="critical">
      <s-paragraph>{error.message}</s-paragraph>

      {error.detail.length > 0 && (
        // Shopify's own words, verbatim. `userErrors` entries arrive here, and
        // paraphrasing them would remove the only description of what the
        // platform actually refused.
        <s-unordered-list>
          {error.detail.map((line) => (
            <s-list-item key={line}>{line}</s-list-item>
          ))}
        </s-unordered-list>
      )}

      {onRetry && (
        <s-button variant="secondary" onClick={onRetry}>
          Try again
        </s-button>
      )}
    </s-banner>
  );
}

export function App(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>({ status: 'loading' });
  const [pending, setPending] = useState<PendingAction>(null);
  const [actionError, setActionError] = useState<ApiRequestError | null>(null);

  const load = useCallback(async () => {
    setScreen({ status: 'loading' });
    try {
      setScreen({ status: 'ready', bundles: await fetchBundles() });
    } catch (error) {
      setScreen({ status: 'failed', error: describeError(error) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onCreateStarter = useCallback(async () => {
    setPending('starter');
    setActionError(null);
    try {
      const bundle = await createStarterBundle();
      shopify.toast.show(`${bundle.title} created`);
      await load();
    } catch (error) {
      // The list stays on screen: losing it would punish the merchant twice for
      // one failed action.
      setActionError(describeError(error));
    } finally {
      setPending(null);
    }
  }, [load]);

  const onPrepareStore = useCallback(async () => {
    setPending('prepare');
    setActionError(null);
    try {
      const report = await prepareStore();
      const created = report.results.filter(
        (result) => result.outcome === 'created',
      );
      shopify.toast.show(
        created.length === 0
          ? 'Store already has every definition this app needs'
          : `Created ${created.map((result) => result.definition).join(', ')}`,
      );
    } catch (error) {
      setActionError(describeError(error));
    } finally {
      setPending(null);
    }
  }, []);

  const bundles = screen.status === 'ready' ? screen.bundles : [];
  const busy = pending !== null;

  return (
    <s-page heading="Routine sets">
      <s-button
        slot="primary-action"
        variant="primary"
        loading={pending === 'starter'}
        disabled={busy}
        onClick={() => void onCreateStarter()}
      >
        Create routine set
      </s-button>
      <s-button
        slot="secondary-actions"
        variant="secondary"
        loading={pending === 'prepare'}
        disabled={busy}
        onClick={() => void onPrepareStore()}
      >
        Prepare store
      </s-button>

      {screen.status === 'failed' && (
        <ErrorBanner error={screen.error} onRetry={() => void load()} />
      )}
      {actionError && <ErrorBanner error={actionError} />}

      {screen.status === 'ready' && bundles.length === 0 ? (
        <s-section accessibilityLabel="No routine sets yet">
          <s-stack direction="block" gap="base" alignItems="center">
            <s-heading>No routine sets yet</s-heading>
            <s-paragraph>
              A routine set is one product per step — cleanse, treat, moisturize
              — shown together on the storefront. The first one can be assembled
              straight from the catalog.
            </s-paragraph>
            <s-button
              variant="primary"
              loading={pending === 'starter'}
              disabled={busy}
              onClick={() => void onCreateStarter()}
            >
              Create one from the catalog
            </s-button>
          </s-stack>
        </s-section>
      ) : (
        <s-section heading="All routine sets">
          {/*
            `loading` is the table's own placeholder state. Polaris 1.0 ships no
            skeleton component — the ones in the 1.1 release candidate are not
            in the stable channel this app loads — so this is the platform's
            answer to "show the shape of the data while it arrives".
          */}
          <s-table loading={screen.status === 'loading'} variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Set</s-table-header>
              {ROUTINE_STEPS.map((step) => (
                <s-table-header key={step} listSlot="labeled">
                  {label(step)}
                </s-table-header>
              ))}
              <s-table-header listSlot="labeled">Status</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {bundles.map((bundle) => (
                <s-table-row key={bundle.id}>
                  <s-table-cell>{bundle.title}</s-table-cell>
                  {ROUTINE_STEPS.map((step) => (
                    <s-table-cell key={step}>
                      <ProductCell bundle={bundle} step={step} />
                    </s-table-cell>
                  ))}
                  <s-table-cell>
                    <s-badge
                      tone={bundle.status === 'active' ? 'success' : 'neutral'}
                    >
                      {label(bundle.status)}
                    </s-badge>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}
    </s-page>
  );
}
