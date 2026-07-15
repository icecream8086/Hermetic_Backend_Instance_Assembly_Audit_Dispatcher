import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  backoffDelay,
  shouldResetBackoff,
  shouldRestart,
} from '../../../src/core/scheduler/backoff.ts';

describe('backoffDelay', () => {
  it('first attempt = 10s', () => {
    expect(backoffDelay(1)).toBe(10_000);
  });

  it('doubles each attempt', () => {
    expect(backoffDelay(2)).toBe(20_000);
    expect(backoffDelay(3)).toBe(40_000);
    expect(backoffDelay(4)).toBe(80_000);
    expect(backoffDelay(5)).toBe(160_000);
  });

  it('caps at 300s', () => {
    expect(backoffDelay(6)).toBe(300_000);
    expect(backoffDelay(10)).toBe(300_000);
    expect(backoffDelay(100)).toBe(300_000);
  });
});

describe('shouldResetBackoff', () => {
  it('resets after 10 minutes of stable runtime', () => {
    const now = Date.now();
    expect(shouldResetBackoff(now - 600_001, now)).toBe(true);
    expect(shouldResetBackoff(now - 600_000, now)).toBe(true);
    expect(shouldResetBackoff(now - 599_999, now)).toBe(false);
    expect(shouldResetBackoff(now - 100_000, now)).toBe(false);
  });
});

describe('shouldRestart', () => {
  it('Always: restarts on any exit code', () => {
    expect(shouldRestart('Always', 0)).toBe(true);
    expect(shouldRestart('Always', 1)).toBe(true);
  });

  it('OnFailure: restarts only on non-zero', () => {
    expect(shouldRestart('OnFailure', 0)).toBe(false);
    expect(shouldRestart('OnFailure', 1)).toBe(true);
    expect(shouldRestart('OnFailure', 137)).toBe(true);
  });

  it('Never: never restarts', () => {
    expect(shouldRestart('Never', 0)).toBe(false);
    expect(shouldRestart('Never', 1)).toBe(false);
  });

  it('per-container rules override pod policy', () => {
    // Pod says OnFailure (restart on exit!=0), container says DoNotRestart on exit 125
    expect(shouldRestart('OnFailure', 125, {
      policy: 'OnFailure',
      rules: [{ action: 'DoNotRestart', operator: 'In', exitCodes: { values: [125] } }],
    })).toBe(false);

    // Pod says Never, container says Restart on exit 1,2
    expect(shouldRestart('Never', 1, {
      policy: 'Never',
      rules: [{ action: 'Restart', operator: 'In', exitCodes: { values: [1, 2] } }],
    })).toBe(true);

    // NotIn operator: DoNotRestart on anything except 0
    expect(shouldRestart('Always', 0, {
      policy: 'Always',
      rules: [{ action: 'DoNotRestart', operator: 'NotIn', exitCodes: { values: [1, 2] } }],
    })).toBe(false);
  });
});

describe('backoffDelay monotonic property (PBT)', () => {
  it('never decreases as n increases', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 20 }), (n) => backoffDelay(n) <= backoffDelay(n + 1)));
  });
});
