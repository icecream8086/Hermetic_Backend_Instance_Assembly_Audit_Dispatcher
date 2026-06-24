import { describe, it, expect } from 'vitest';
import { evaluateProbe, createProbeState } from '../../../src/core/scheduler/probe-runner.ts';
import type { ProbeSpec } from '../../../src/core/provider/types.ts';

function ok() { return Promise.resolve({ success: true as const, message: 'ok' }); }
function fail() { return Promise.resolve({ success: false as const, message: 'fail' }); }
function slowOk(ms: number) { return new Promise<{ success: boolean; message: string }>(r => setTimeout(() => r({ success: true, message: 'ok' }), ms)); }

describe('evaluateProbe', () => {
  it('returns success on healthy container', async () => {
    const state = createProbeState();
    const spec: ProbeSpec = { periodSeconds: 10, timeoutSeconds: 5 };
    const r = await evaluateProbe('liveness', spec, state, () => ok());
    expect(r.success).toBe(true);
    expect(r.shouldRestart).toBe(false);
  });

  it('fails after 2 consecutive failures with failureThreshold=2', async () => {
    const state = createProbeState();
    const spec: ProbeSpec = { failureThreshold: 2, periodSeconds: 1, timeoutSeconds: 5 };
    // Call 1: fail, but only 1/2 consecutive
    await evaluateProbe('liveness', spec, state, () => fail(), 100000);
    // Call 2: fail again → 2/2 → should restart
    const r = await evaluateProbe('liveness', spec, state, () => fail(), 200000);
    expect(r.success).toBe(false);
    expect(r.shouldRestart).toBe(true);
  });

  it('failure count resets after a success', async () => {
    const state = createProbeState();
    const spec: ProbeSpec = { failureThreshold: 3, periodSeconds: 1, timeoutSeconds: 5 };
    await evaluateProbe('liveness', spec, state, () => fail(), 100000);
    await evaluateProbe('liveness', spec, state, () => ok(), 200000);  // reset
    await evaluateProbe('liveness', spec, state, () => fail(), 300000);
    const r = await evaluateProbe('liveness', spec, state, () => fail(), 400000);
    expect(r.shouldRestart).toBe(false); // only 1 consecutive failure since reset
  });

  it('readiness probe never triggers restart', async () => {
    const state = createProbeState();
    const spec: ProbeSpec = { failureThreshold: 2, periodSeconds: 1, timeoutSeconds: 5 };
    await evaluateProbe('readiness', spec, state, () => fail(), 100000);
    const r = await evaluateProbe('readiness', spec, state, () => fail(), 200000);
    expect(r.success).toBe(false);
    expect(r.shouldRestart).toBe(false);
    expect(r.shouldRemoveEndpoint).toBe(true);
  });

  it('skips when period not elapsed', async () => {
    const state = createProbeState();
    const spec: ProbeSpec = { periodSeconds: 60, timeoutSeconds: 5 };
    await evaluateProbe('liveness', spec, state, () => ok(), 100000);
    const r = await evaluateProbe('liveness', spec, state, () => ok(), 100001); // only 1ms later
    expect(r.message).toContain('skipped');
  });

  it('no spec passes', async () => {
    const state = createProbeState();
    const r = await evaluateProbe('liveness', undefined, state, () => ok());
    expect(r.success).toBe(true);
  });

  it('timeout makes probe fail', async () => {
    const state = createProbeState();
    const spec: ProbeSpec = { timeoutSeconds: 0.001, failureThreshold: 1, periodSeconds: 1 };
    const r = await evaluateProbe('liveness', spec, state, () => slowOk(5000), 100000);
    expect(r.success).toBe(false);
    expect(r.shouldRestart).toBe(true);
  });

  it('startup probe gates liveness', async () => {
    const state = createProbeState();
    const startupSpec: ProbeSpec = { failureThreshold: 1, periodSeconds: 1, timeoutSeconds: 5 };
    const livenessSpec: ProbeSpec = { failureThreshold: 1, periodSeconds: 1, timeoutSeconds: 5 };

    await evaluateProbe('startup', startupSpec, state, () => fail(), 100000);
    const r = await evaluateProbe('liveness', livenessSpec, state, () => ok(), 200000);
    expect(r.message).toContain('gated by startup probe');

    await evaluateProbe('startup', startupSpec, state, () => ok(), 300000);
    const r2 = await evaluateProbe('liveness', livenessSpec, state, () => ok(), 400000);
    expect(r2.success).toBe(true);
  });
});
