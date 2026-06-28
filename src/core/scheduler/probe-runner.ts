/**
 * Probe evaluation — kubelet-style health check execution.
 *
 * Three probe types:
 *   livenessProbe  — container is alive?  Failure → restart
 *   readinessProbe — can serve traffic?   Failure → remove from endpoints
 *   startupProbe   — has started?          Failure → restart (liveness/readiness disabled during startup)
 *
 * Handler types:
 *   exec      — run command inside container (exit 0 = success)
 *   httpGet   — HTTP GET to container port (2xx/3xx = success)
 *   tcpSocket — TCP connect to container port (established = success)
 *
 * References:
 *   K8s Pod lifecycle: https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#container-probes
 */

import type { ProbeSpec } from '../provider/types.ts';

// ─── Probe types ───

export type ProbeType = 'liveness' | 'readiness' | 'startup';

export interface ProbeResult {
  type: ProbeType;
  success: boolean;
  message?: string;
  /** If true, container should be restarted. */
  shouldRestart: boolean;
  /** If true, container should be removed from service endpoints. */
  shouldRemoveEndpoint: boolean;
}

export interface ProbeState {
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastProbeAt: number;
  /** True when no startup probe is configured OR startup probe has succeeded. Default true. */
  startupComplete: boolean;
  /** Set to true when a startup probe is first evaluated. Enables gating. */
  hasStartupProbe: boolean;
}

// ─── Defaults (K8s-aligned) ───

const DEFAULT_INITIAL_DELAY = 0;
const DEFAULT_TIMEOUT = 1;       // seconds
const DEFAULT_PERIOD = 10;       // seconds
const DEFAULT_SUCCESS_THRESHOLD = 1;
const DEFAULT_FAILURE_THRESHOLD = 3;

// ─── Evaluation ───

/** Simulate running a probe against a container. Returns success + optional message. */
export type ProbeHandler = (spec: ProbeSpec) => Promise<{ success: boolean; message?: string }>;

/** Create a state tracker for a container's probes. */
export function createProbeState(): ProbeState {
  return { consecutiveFailures: 0, consecutiveSuccesses: 0, lastProbeAt: 0, startupComplete: true, hasStartupProbe: false };
}

/** Evaluate a probe and return the result. */
export async function evaluateProbe(
  type: ProbeType,
  spec: ProbeSpec | undefined,
  state: ProbeState,
  handler: ProbeHandler,
  now: number = Date.now(),
): Promise<ProbeResult> {
  if (!spec) {
    return { type, success: true, message: 'no probe configured', shouldRestart: false, shouldRemoveEndpoint: false };
  }

  const periodMs = (spec.periodSeconds ?? DEFAULT_PERIOD) * 1000;
  if (now - state.lastProbeAt < periodMs) {
    return { type, success: true, message: 'skipped (not due)', shouldRestart: false, shouldRemoveEndpoint: false };
  }
  state.lastProbeAt = now;

  // During startup, only run startupProbe; liveness/readiness are gated
  if (type === 'startup') {
    state.hasStartupProbe = true;
    state.startupComplete = false; // set to false first time startup probe runs
    // Will be set to true below if successThreshold met
  }
  if (!state.startupComplete && state.hasStartupProbe && type !== 'startup') {
    return { type, success: true, message: 'gated by startup probe', shouldRestart: false, shouldRemoveEndpoint: false };
  }

  const timeoutMs = (spec.timeoutSeconds ?? DEFAULT_TIMEOUT) * 1000;
  let success = false;
  let message = '';

  try {
    const result = await Promise.race([
      handler(spec),
      new Promise<{ success: false; message: string }>((_, reject) =>
        setTimeout(() => { reject(new Error('probe timeout')); }, timeoutMs),
      ),
    ]);
    success = result.success;
    message = result.message ?? '';
  } catch (e: any) {
    success = false;
    message = e?.message ?? 'probe error';
  }

  // Update state
  if (success) {
    state.consecutiveSuccesses++;
    state.consecutiveFailures = 0;
  } else {
    state.consecutiveFailures++;
    state.consecutiveSuccesses = 0;
  }

  // Threshold checks
  const failureThreshold = spec.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  const successThreshold = spec.successThreshold ?? DEFAULT_SUCCESS_THRESHOLD;

  const isFailing = state.consecutiveFailures >= failureThreshold;

  // Startup probe: on first success, mark startup complete
  if (type === 'startup' && state.consecutiveSuccesses >= successThreshold) {
    state.startupComplete = true;
  }

  if (type === 'startup' && success) {
    // Pass initialDelaySeconds after first startup success
    const initialDelayMs = (spec.initialDelaySeconds ?? DEFAULT_INITIAL_DELAY) * 1000;
    if (initialDelayMs > 0 && now - state.lastProbeAt < initialDelayMs) {
      return { type, success: true, message: 'startup probe passed', shouldRestart: false, shouldRemoveEndpoint: false };
    }
  }

  return {
    type,
    success,
    message: success ? message || 'probe passed' : message || `probe failed (${state.consecutiveFailures}/${failureThreshold})`,
    shouldRestart: isFailing && type !== 'readiness',  // readiness failure → don't restart
    shouldRemoveEndpoint: isFailing && type === 'readiness',
  };
}

