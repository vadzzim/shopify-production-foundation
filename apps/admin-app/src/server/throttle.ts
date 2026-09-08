import type { GraphqlCost, ThrottleStatus } from './admin-graphql';

/**
 * Proactive rate-limit pacing for loops of Admin API calls (rule 4).
 *
 * The Admin API is a leaky bucket measured in query cost points, not in
 * requests: every response reports `extensions.cost.throttleStatus` with what
 * is left in the bucket and how fast it refills. Reacting only to a `THROTTLED`
 * error works, but it means every loop pays for one rejected request per empty
 * bucket, and under concurrency several callers discover the same empty bucket
 * at the same moment.
 *
 * So this gate reads what the last response reported and waits *before* the
 * next call when the bucket cannot afford it.
 *
 * The wait carries jitter. Without it, several callers that hit the same empty
 * bucket compute the same delay, wake together, and empty it together — a
 * thundering herd that turns one throttle into a repeating cycle. Jitter
 * spreads the retries apart.
 *
 * `@shopify/shopify-api`'s client also retries a throttled request on its own.
 * That stays as the safety net for the case this gate cannot predict; the gate
 * exists so the common case does not need it.
 */

export interface ThrottleGateOptions {
  /** Injected for tests: the real one is `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests: the real one is `Math.random`. */
  random?: () => number;
  /**
   * How much of the previous call's cost to assume the next one will need.
   * Above 1 it waits for headroom; the default assumes calls in a loop cost
   * roughly the same, which is true when the loop repeats one operation.
   */
  headroom?: number;
  /** Upper bound on a single wait, so a pathological reading cannot hang a request. */
  maxWaitMs?: number;
  /** Fraction of the computed wait added at random. */
  jitterRatio?: number;
}

export interface ThrottleGate {
  /** Wait, if the last reading says the bucket cannot afford another call. */
  beforeCall(): Promise<void>;
  /** Record `extensions.cost` from a response. Missing fields are ignored. */
  record(cost: GraphqlCost | undefined): void;
  /** The most recent bucket reading, or `undefined` before the first call. */
  status(): ThrottleStatus | undefined;
  /** Total time this gate has spent waiting, in milliseconds. For logging. */
  waitedMs(): number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function createThrottleGate(
  options: ThrottleGateOptions = {},
): ThrottleGate {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const headroom = options.headroom ?? 1;
  const maxWaitMs = options.maxWaitMs ?? 10_000;
  const jitterRatio = options.jitterRatio ?? 0.5;

  let status: ThrottleStatus | undefined;
  let lastCost: number | undefined;
  let waited = 0;

  return {
    status: () => status,
    waitedMs: () => waited,

    record(cost) {
      const observed = cost?.throttleStatus;
      if (
        observed &&
        typeof observed.maximumAvailable === 'number' &&
        typeof observed.currentlyAvailable === 'number' &&
        typeof observed.restoreRate === 'number'
      ) {
        status = {
          maximumAvailable: observed.maximumAvailable,
          currentlyAvailable: observed.currentlyAvailable,
          restoreRate: observed.restoreRate,
        };
      }

      const cost_ = cost?.actualQueryCost ?? cost?.requestedQueryCost;
      if (typeof cost_ === 'number' && cost_ > 0) {
        lastCost = cost_;
      }
    },

    async beforeCall() {
      // Nothing observed yet, or a reading we cannot compute a wait from: the
      // first call in a loop has no basis for a delay, and a zero restore rate
      // would divide by zero. Let the request through and learn from it.
      if (!status || lastCost === undefined || status.restoreRate <= 0) return;

      const needed = lastCost * headroom;
      const deficit = needed - status.currentlyAvailable;
      if (deficit <= 0) return;

      const baseMs = (deficit / status.restoreRate) * 1000;
      const withJitter = baseMs * (1 + random() * jitterRatio);
      const waitMs = Math.min(Math.ceil(withJitter), maxWaitMs);

      await sleep(waitMs);
      waited += waitMs;

      // Credit the bucket for the time spent waiting. Without this, a loop
      // whose next call fails before reporting a new reading would wait the
      // same amount again on the following iteration.
      status = {
        ...status,
        currentlyAvailable: Math.min(
          status.maximumAvailable,
          status.currentlyAvailable + (status.restoreRate * waitMs) / 1000,
        ),
      };
    },
  };
}
