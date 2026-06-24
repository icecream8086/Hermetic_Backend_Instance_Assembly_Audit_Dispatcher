import type { TriggerRule, TaskInstanceState } from './types.ts';
import { isTaskTerminal } from './types.ts';

/**
 * Evaluate an Airflow-compatible trigger rule against upstream TaskInstance states.
 *
 * Rules reference:
 *   - all_success               — every upstream must be SUCCESS
 *   - all_failed                — every upstream must be FAILED or UPSTREAM_FAILED
 *   - all_done                  — every upstream must be terminal (any terminal state)
 *   - one_success               — at least one upstream is SUCCESS
 *   - one_failed                — at least one upstream is FAILED or UPSTREAM_FAILED
 *   - none_failed               — no upstream is FAILED or UPSTREAM_FAILED
 *   - none_skipped              — no upstream is SKIPPED
 *   - none_failed_min_one_success — no FAILED upstream AND at least one SUCCESS
 *   - always                    — always true (no dependency)
 *
 * Returns true if the downstream task should be scheduled.
 */
export function evaluateTriggerRule(
  rule: TriggerRule,
  upstreamStates: readonly TaskInstanceState[],
): boolean {
  if (upstreamStates.length === 0) return true;

  switch (rule) {
    case 'all_success':
      return upstreamStates.every(s => s === 'SUCCESS');

    case 'all_failed': {
      if (upstreamStates.length === 0) return false;
      return upstreamStates.every(s => s === 'FAILED' || s === 'UPSTREAM_FAILED');
    }

    case 'all_done': {
      return upstreamStates.every(s => isTaskTerminal(s));
    }

    case 'one_success': {
      return upstreamStates.some(s => s === 'SUCCESS');
    }

    case 'one_failed': {
      return upstreamStates.some(s => s === 'FAILED' || s === 'UPSTREAM_FAILED');
    }

    case 'none_failed': {
      return !upstreamStates.some(s => s === 'FAILED' || s === 'UPSTREAM_FAILED');
    }

    case 'none_skipped': {
      return !upstreamStates.some(s => s === 'SKIPPED');
    }

    case 'none_failed_min_one_success': {
      const noFail = !upstreamStates.some(s => s === 'FAILED' || s === 'UPSTREAM_FAILED');
      const oneOk = upstreamStates.some(s => s === 'SUCCESS');
      return noFail && oneOk;
    }

    case 'always':
      return true;

    default:
      return false;
  }
}
