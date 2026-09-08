import { useCallback, useEffect, useState } from 'react';
import {
  ROUTINE_STEPS,
  type CatalogExportReport,
  type CatalogExportStatus,
  type JobStatus,
} from '@nordlys/shared';

import { ApiRequestError, fetchCatalogExport, startCatalogExport } from './api';

/**
 * What the whole catalog says about routine steps.
 *
 * The picker in the editor reads a bounded slice of the catalog, because a
 * request cannot walk a hundred thousand products (ADR-0004). This section is
 * the unbounded answer: a bulk operation runs on Shopify's side and the numbers
 * arrive minutes later.
 *
 * It is deliberately a report and not a list. Every product is not something a
 * merchant needs to scroll here — they have the admin for that — but "eleven
 * active products have no routine step, and two say *moisturise*" is a thing
 * they can act on and cannot discover anywhere else, because a product with a
 * misspelled step is simply absent from every other screen.
 */

/** How often the section re-checks a running export. */
const REFRESH_MS = 5_000;

/** Statuses that mean the queue will come back to this job. */
const IN_FLIGHT: JobStatus[] = ['pending', 'running', 'failed'];

function label(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function when(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function CatalogReport(): React.JSX.Element {
  const [status, setStatus] = useState<CatalogExportStatus | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setStatus(await fetchCatalogExport());
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught
          : new ApiRequestError('Could not read the catalog export.', 0),
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onExport = useCallback(async (): Promise<void> => {
    setPending(true);
    setError(null);

    try {
      setStatus(await startCatalogExport());
      shopify.toast.show('Catalog export queued');
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught
          : new ApiRequestError('The export could not be started.', 0),
      );
    } finally {
      setPending(false);
    }
  }, []);

  const job = status?.job ?? null;
  const report = status?.report ?? null;
  const running = job !== null && IN_FLIGHT.includes(job.status);

  useEffect(() => {
    // Only while an export is actually in flight. A finished report does not
    // change on its own, and a timer that ran regardless would be a request
    // every five seconds for the lifetime of an open tab.
    if (!running) return undefined;

    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, [running, load]);

  return (
    <s-section heading="Catalog">
      <s-stack direction="block" gap="base">
        <s-paragraph>
          A routine set can only use a product whose{' '}
          <s-text type="strong">custom.routine_step</s-text> metafield is set.
          The export reads every active product to say how many are ready, and
          which are not.
        </s-paragraph>

        {error && (
          <s-banner heading="This did not work" tone="critical">
            <s-paragraph>{error.message}</s-paragraph>
          </s-banner>
        )}

        {job?.status === 'dead' && job.lastError && (
          <s-banner heading="The last export did not finish" tone="warning">
            <s-paragraph>{job.lastError}</s-paragraph>
          </s-banner>
        )}

        <s-stack direction="inline" gap="base" alignItems="center">
          <s-button
            variant="secondary"
            loading={pending}
            disabled={pending || running}
            onClick={() => void onExport()}
          >
            Export catalog
          </s-button>

          {running && (
            <s-text color="subdued">
              Running. Shopify does this in the background; the numbers below
              update when it finishes.
            </s-text>
          )}
        </s-stack>

        {report ? (
          <Summary report={report} />
        ) : (
          <s-paragraph color="subdued">
            No export has finished yet.
          </s-paragraph>
        )}
      </s-stack>
    </s-section>
  );
}

function Summary({
  report,
}: {
  report: CatalogExportReport;
}): React.JSX.Element {
  return (
    <s-stack direction="block" gap="base">
      <s-text color="subdued">
        {report.objectCount} active products, read {when(report.completedAt)}
      </s-text>

      <s-table variant="auto">
        <s-table-header-row>
          <s-table-header listSlot="primary">Step</s-table-header>
          <s-table-header listSlot="labeled">Products</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {ROUTINE_STEPS.map((step) => (
            <s-table-row key={step}>
              <s-table-cell>{label(step)}</s-table-cell>
              <s-table-cell>
                <s-stack direction="inline" gap="small-300" alignItems="center">
                  <s-text>{report.byStep[step] ?? 0}</s-text>
                  {(report.byStep[step] ?? 0) === 0 && (
                    // A step with no products is why "Create routine set"
                    // refuses, and saying so here is cheaper than making the
                    // merchant discover it by pressing the button.
                    <s-badge tone="critical">No routine set can use it</s-badge>
                  )}
                </s-stack>
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>

      {report.withoutStep > 0 && (
        <s-stack direction="block" gap="small-300">
          <s-text>
            {report.withoutStep} active products have no routine step.
          </s-text>
          <s-unordered-list>
            {report.sampleWithoutStep.map((product) => (
              <s-list-item key={product.productGid}>{product.title}</s-list-item>
            ))}
          </s-unordered-list>
          {report.withoutStep > report.sampleWithoutStep.length && (
            <s-text color="subdued">
              …and {report.withoutStep - report.sampleWithoutStep.length} more.
            </s-text>
          )}
        </s-stack>
      )}

      {report.unrecognisedSteps.length > 0 && (
        <s-banner heading="Some products use a step this app does not know" tone="warning">
          <s-paragraph>
            The theme filters on the exact value of the metafield, so these
            products appear in no routine set and on no other screen here.
          </s-paragraph>
          <s-unordered-list>
            {report.unrecognisedSteps.map((entry) => (
              <s-list-item key={entry.value}>
                “{entry.value}” — {entry.count} products
              </s-list-item>
            ))}
          </s-unordered-list>
        </s-banner>
      )}
    </s-stack>
  );
}
