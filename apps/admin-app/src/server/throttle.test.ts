import { describe, expect, it } from 'vitest';

import { createThrottleGate } from './throttle';

function recorder() {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

const bucket = (currentlyAvailable: number, restoreRate = 100) => ({
  requestedQueryCost: 50,
  actualQueryCost: 50,
  throttleStatus: {
    maximumAvailable: 2000,
    currentlyAvailable,
    restoreRate,
  },
});

describe('createThrottleGate', () => {
  it('does not wait before the first call', () => {
    // Nothing has been observed yet, so any delay would be invented.
    const { waits, sleep } = recorder();
    const gate = createThrottleGate({ sleep });

    return gate.beforeCall().then(() => {
      expect(waits).toEqual([]);
    });
  });

  it('does not wait while the bucket can afford the next call', async () => {
    const { waits, sleep } = recorder();
    const gate = createThrottleGate({ sleep });

    gate.record(bucket(1900));
    await gate.beforeCall();

    expect(waits).toEqual([]);
  });

  it('waits for the deficit to refill when the bucket is short', async () => {
    const { waits, sleep } = recorder();
    // random() = 0 removes the jitter, so the arithmetic is checkable.
    const gate = createThrottleGate({ sleep, random: () => 0 });

    // 10 points left, the last call cost 50, refilling at 100 points a second:
    // 40 points short is 400 ms.
    gate.record(bucket(10));
    await gate.beforeCall();

    expect(waits).toEqual([400]);
    expect(gate.waitedMs()).toBe(400);
  });

  it('adds jitter so concurrent callers do not wake together', async () => {
    // Without jitter, every caller that met the same empty bucket computes the
    // same delay, wakes at the same moment and empties it again.
    const { waits, sleep } = recorder();
    const gate = createThrottleGate({ sleep, random: () => 1, jitterRatio: 0.5 });

    gate.record(bucket(10));
    await gate.beforeCall();

    expect(waits).toEqual([600]);
  });

  it('caps a single wait', async () => {
    const { waits, sleep } = recorder();
    const gate = createThrottleGate({
      sleep,
      random: () => 0,
      maxWaitMs: 1_000,
    });

    // A trickle-refill bucket would otherwise ask for a two-minute sleep inside
    // a request.
    gate.record({ ...bucket(0), throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 0, restoreRate: 1 } });
    await gate.beforeCall();

    expect(waits).toEqual([1_000]);
  });

  it('credits the bucket for the time it waited', async () => {
    const { sleep } = recorder();
    const gate = createThrottleGate({ sleep, random: () => 0 });

    gate.record(bucket(10));
    await gate.beforeCall();

    // 400 ms at 100 points a second is 40 points, on top of the 10 that were
    // left. Without this, a call that fails before reporting a new reading
    // would make the next iteration wait all over again.
    expect(gate.status()?.currentlyAvailable).toBe(50);
  });

  it('ignores a reading it cannot compute a wait from', async () => {
    const { waits, sleep } = recorder();
    const gate = createThrottleGate({ sleep });

    gate.record({ requestedQueryCost: 50 });
    await gate.beforeCall();

    expect(waits).toEqual([]);
    expect(gate.status()).toBeUndefined();
  });

  it('does not divide by a zero restore rate', async () => {
    const { waits, sleep } = recorder();
    const gate = createThrottleGate({ sleep });

    gate.record(bucket(0, 0));
    await gate.beforeCall();

    expect(waits).toEqual([]);
  });
});
