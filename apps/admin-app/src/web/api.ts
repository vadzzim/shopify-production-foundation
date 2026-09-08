import {
  apiErrorSchema,
  bundleListResponseSchema,
  bundleSchema,
  storeSetupReportSchema,
  type Bundle,
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

export async function prepareStore(): Promise<StoreSetupReport> {
  const { report } = await request(
    '/api/store/prepare',
    z.object({ report: storeSetupReportSchema }),
    { method: 'POST' },
  );
  return report;
}
