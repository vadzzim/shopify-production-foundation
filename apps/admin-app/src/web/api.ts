import {
  apiErrorSchema,
  bundleListResponseSchema,
  bundleSchema,
  catalogCandidatesSchema,
  jobListResponseSchema,
  jobSummarySchema,
  storeSetupReportSchema,
  type Bundle,
  type BundleUpdate,
  type CatalogCandidates,
  type JobSummary,
  type StoreSetupReport,
} from '@nordlys/shared';
import { z } from 'zod';

/**
 * The browser half of the API.
 *
 * There is no auth code here, and that is not an omission. App Bridge patches
 * `fetch` so that same-origin requests carry a signed session token, which the
 * server verifies with `validateAuthenticatedSession`. Adding our own header
 * would duplicate a mechanism that already exists and get it subtly wrong.
 *
 * Every response is parsed with the same zod schema the server builds it from.
 * The alternative — casting `await response.json()` to a type — makes the
 * compiler agree with an assumption nothing checks, so a renamed field becomes
 * `undefined` in the UI instead of an error at the boundary.
 */

export class ApiRequestError extends Error {
  readonly detail: readonly string[];
  readonly status: number;

  constructor(message: string, status: number, detail: readonly string[] = []) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.detail = detail;
  }
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(path, init);
  } catch (cause) {
    // A network failure, or the tunnel going away mid-session. Reported as its
    // own case because "retry" is the right offer here and usually is not for
    // a 4xx.
    throw new ApiRequestError(
      'Could not reach the app server. Check that it is still running.',
      0,
      [cause instanceof Error ? cause.message : String(cause)],
    );
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload);

    if (parsed.success) {
      throw new ApiRequestError(
        parsed.data.error.message,
        response.status,
        parsed.data.error.detail ?? [],
      );
    }

    throw new ApiRequestError(
      `The app server answered ${response.status} without an error body.`,
      response.status,
    );
  }

  const parsed = schema.safeParse(payload);

  if (!parsed.success) {
    throw new ApiRequestError(
      'The app server answered in a shape this screen does not understand.',
      response.status,
      parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
    );
  }

  return parsed.data;
}

export async function fetchBundles(): Promise<Bundle[]> {
  const { bundles } = await request('/api/bundles', bundleListResponseSchema);
  return bundles;
}

export async function createStarterBundle(): Promise<Bundle> {
  const { bundle } = await request(
    '/api/bundles/starter',
    z.object({ bundle: bundleSchema }),
    { method: 'POST' },
  );
  return bundle;
}

export async function updateBundle(
  id: string,
  update: BundleUpdate,
): Promise<Bundle> {
  const { bundle } = await request(
    `/api/bundles/${encodeURIComponent(id)}`,
    z.object({ bundle: bundleSchema }),
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    },
  );
  return bundle;
}

/**
 * Delete a routine set.
 *
 * Its own function rather than a flag on {@link request}, because the server
 * answers 204 with no body at all: `response.json()` on an empty body throws,
 * and a schema that has to accept `null` to describe "nothing" would weaken
 * every other response this file parses.
 */
export async function deleteBundle(id: string): Promise<void> {
  let response: Response;

  try {
    response = await fetch(`/api/bundles/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  } catch (cause) {
    throw new ApiRequestError(
      'Could not reach the app server. Check that it is still running.',
      0,
      [cause instanceof Error ? cause.message : String(cause)],
    );
  }

  if (response.ok) return;

  const payload: unknown = await response.json().catch(() => null);
  const parsed = apiErrorSchema.safeParse(payload);

  throw new ApiRequestError(
    parsed.success
      ? parsed.data.error.message
      : `The app server answered ${String(response.status)} without an error body.`,
    response.status,
    parsed.success ? (parsed.data.error.detail ?? []) : [],
  );
}

export async function fetchCandidates(): Promise<CatalogCandidates> {
  return request('/api/catalog/candidates', catalogCandidatesSchema);
}

export async function prepareStore(): Promise<StoreSetupReport> {
  const { report } = await request(
    '/api/store/prepare',
    z.object({ report: storeSetupReportSchema }),
    { method: 'POST' },
  );
  return report;
}

export async function fetchJobs(): Promise<JobSummary[]> {
  const { jobs } = await request('/api/jobs', jobListResponseSchema);
  return jobs;
}

/**
 * Put a failed job back on the queue.
 *
 * The server resets the row and lets the worker pick it up, rather than running
 * the job inline: a manual retry then takes exactly the same path as an
 * automatic one and cannot behave differently from it. Which is why this
 * returns a job that is `pending`, not one that has already succeeded — the
 * screen reloads to find out.
 */
export async function retryJob(id: string): Promise<JobSummary> {
  const { job } = await request(
    `/api/jobs/${encodeURIComponent(id)}/retry`,
    z.object({ job: jobSummarySchema }),
    { method: 'POST' },
  );
  return job;
}
