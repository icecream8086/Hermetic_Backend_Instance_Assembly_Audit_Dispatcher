/**
 * Exponential backoff for container restart (K8s-aligned).
 *
 * Delay = min(10s × 2^(attempt-1), 300s)
 * Reset after 10 minutes of stable runtime.
 */

/** Restart policy values — mirrors K8s Pod restartPolicy. */
export type RestartPolicy = 'Always' | 'OnFailure' | 'Never';

/** Per-container restart policy (K8s v1.34 Alpha — KEP-5307). */
export interface ContainerRestartPolicy {
  policy: RestartPolicy;
  /** Exit-code-based rules. Evaluated in order, first match wins. */
  rules?: readonly RestartPolicyRule[];
}

export interface RestartPolicyRule {
  action: 'Restart' | 'DoNotRestart';
  operator: 'In' | 'NotIn';
  exitCodes: { values: readonly number[] };
}

const MIN_BACKOFF_MS = 10_000;   // 10s
const MAX_BACKOFF_MS = 300_000;  // 5 min
const RESET_AFTER_MS  = 600_000; // 10 min

/** Calculate the backoff delay for a given attempt number (1-based). */
export function backoffDelay(attempt: number): number {
  if (attempt <= 1) return MIN_BACKOFF_MS;
  return Math.min(MIN_BACKOFF_MS * Math.pow(2, attempt - 1), MAX_BACKOFF_MS);
}

/** Check if the backoff timer should reset because the container has been stable long enough. */
export function shouldResetBackoff(runningSince: number, now: number = Date.now()): boolean {
  return (now - runningSince) >= RESET_AFTER_MS;
}

/** Determine whether a container should be restarted based on exit code and policy. */
export function shouldRestart(
  policy: RestartPolicy,
  exitCode: number,
  perContainer?: ContainerRestartPolicy,
): boolean {
  // Per-container rules take precedence
  if (perContainer?.rules) {
    for (const rule of perContainer.rules) {
      const matches = rule.operator === 'In'
        ? rule.exitCodes.values.includes(exitCode)
        : !rule.exitCodes.values.includes(exitCode);
      if (matches) return rule.action === 'Restart';
    }
  }
  // Fall back to standard K8s semantics
  switch (policy) {
    case 'Always': return true;
    case 'OnFailure': return exitCode !== 0;
    case 'Never': return false;
  }
}
