import { useCallback, useEffect, useState } from 'react';
import type { JobStatus, JobSummary } from '@nordlys/shared';

import { ApiRequestError, fetchJobs, retryJob } from './api';

/**
 * The sync log.
 *
 * This is the half of phase 3's completion criterion that is not code
 * correctness: *an external system failure is visible in the UI and can be
 * retried manually.* Without it the queue is a table nobody can see, and a
 * merchant whose stock stopped syncing at 3am learns about it from their
 * customers.
 *
 * Two decisions about what to show, both worth defending:
 *
 * **The error text is shown verbatim.** "Shopify answered 503" and "the ERP
 * refused the connection" call for different actions, and a merchant told only
 * "sync failed" has been told nothing they can act on. Same reasoning as
 * passing `userErrors` through on the bundle screen.
 *
 * **A retry is offered only where it means something.** A job that is pending
 * or running has nothing to retry, and one that already succeeded would be run
 * twice. So the button appears on failed and dead rows, and the server refuses
 * anything else regardless of what this screen renders.
 */

type Screen =
  | { status: 'loading' }
  | { status: 'ready'; jobs: JobSummary[] }
  | { status: 'failed'; error: ApiRequestError };

/**
 * How often the log refreshes itself while it is open.
 *
 * The worker polls every couple of seconds, so a job's status changes under a
 * screen that is simply left open — a merchant who presses Retry and watches
 * should see it resolve without reaching for the browser's reload button. Ten
 * seconds is slow enough to be free and fast enough to feel live.
 */
const REFRESH_MS = 10_000;

/**
 * Typed against Polaris's own tone union rather than `string`, so a tone the
 * component does not accept is a compile error instead of a badge that renders
 * with no colour.
 */
const TONE_BY_STATUS: Record<
  JobStatus,
  'info' | 'success' | 'warning' | 'critical'
> = {
  pending: 'info',
  running: 'info',
  succeeded: 'success',
  failed: 'warning',
  // The dead-letter state: out of attempts, and nothing will touch it again
  // unless a person does.
  dead: 'critical',
};

function isRetryable(status: JobStatus): boolean {
  return status === 'failed' || status === 'dead';
}

function label(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * A timestamp a merchant can read at a glance.
 *
 * Rendered in the browser's locale and time zone rather than in the UTC the API
 * returns: the person reading this is deciding whether a failure is from five
 * minutes ago or from last Tuesday, and doing the offset arithmetic in their
 * head is where that goes wrong.
 */
function when(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function SyncLog(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>({ status: 'loading' });
  const [retrying, setRetrying] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ApiRequestError | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setScreen({ status: 'ready', jobs: await fetchJobs() });
    } catch (error) {
      setScreen({
        status: 'failed',
        error:
          error instanceof ApiRequestError
            ? error
            : new ApiRequestError('Could not load the sync log.', 0),
      });
    }
  }, []);

  useEffect(() => {
    void load();

    const timer = setInterval(() => void load(), REFRESH_MS);
    // Cleared on unmount, so a screen the merchant has navigated away from does
    // not keep polling an endpoint nobody is looking at.
    return () => {
      clearInterval(timer);
    };
  }, [load]);

  const onRetry = useCallback(
    async (id: string): Promise<void> => {
      setRetrying(id);
      setActionError(null);
      try {
        await retryJob(id);
        shopify.toast.show('Queued for another attempt');
        // Reload rather than patch the row in place: the worker may already
        // have picked it up, and showing "pending" for something that is
        // running would be a screen disagreeing with the database.
        await load();
      } catch (error) {
        setActionError(
          error instanceof ApiRequestError
            ? error
            : new ApiRequestError('The retry did not go through.', 0),
        );
      } finally {
        setRetrying(null);
      }
    },
    [load],
  );

  const jobs = screen.status === 'ready' ? screen.jobs : [];

  if (screen.status === 'ready' && jobs.length === 0) {
    return (
      <s-section heading="Sync log">
        <s-paragraph>
          Nothing has been queued yet. Webhooks from Shopify — new orders,
          product edits — appear here as they are processed, and anything that
          fails stays visible with the reason.
        </s-paragraph>
      </s-section>
    );
  }

  return (
    <s-section heading="Sync log">
      {screen.status === 'failed' && (
        <s-banner heading="Could not load the sync log" tone="critical">
          <s-paragraph>{screen.error.message}</s-paragraph>
        </s-banner>
      )}

      {actionError && (
        <s-banner heading="The retry did not go through" tone="critical">
          <s-paragraph>{actionError.message}</s-paragraph>
        </s-banner>
      )}

      <s-table loading={screen.status === 'loading'} variant="auto">
        <s-table-header-row>
          <s-table-header listSlot="primary">Event</s-table-header>
          <s-table-header listSlot="labeled">Status</s-table-header>
          <s-table-header listSlot="labeled">Attempts</s-table-header>
          <s-table-header listSlot="labeled">Received</s-table-header>
          <s-table-header listSlot="labeled">Detail</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {jobs.map((job) => (
            <s-table-row key={job.id}>
              <s-table-cell>
                <s-stack direction="block" gap="small-500">
                  <s-text>{job.topic ?? job.kind}</s-text>
                  {/*
                    The correlation id, shown rather than hidden. It is the one
                    string that ties this row to every log line the delivery
                    produced and to Shopify's own delivery record, so a merchant
                    reporting a problem can quote it and it can be grepped.
                  */}
                  <s-text color="subdued">{job.correlationId}</s-text>
                </s-stack>
              </s-table-cell>
              <s-table-cell>
                <s-badge tone={TONE_BY_STATUS[job.status]}>
                  {label(job.status)}
                </s-badge>
              </s-table-cell>
              <s-table-cell>
                <s-text>
                  {job.attempts} of {job.maxAttempts}
                </s-text>
              </s-table-cell>
              <s-table-cell>
                <s-text>{when(job.createdAt)}</s-text>
              </s-table-cell>
              <s-table-cell>
                <s-stack direction="block" gap="small-300">
                  {job.lastError && (
                    // `tone`, not `color`: on Polaris text `color` is only
                    // base/subdued, and the semantic colours live on `tone`.
                    <s-text tone="critical">{job.lastError}</s-text>
                  )}
                  {isRetryable(job.status) && (
                    <s-button
                      variant="secondary"
                      loading={retrying === job.id}
                      disabled={retrying !== null}
                      onClick={() => void onRetry(job.id)}
                    >
                      Retry
                    </s-button>
                  )}
                </s-stack>
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    </s-section>
  );
}
