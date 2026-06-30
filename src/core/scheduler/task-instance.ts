import type { TaskInstance, TaskInstanceState } from '../dag/types.ts';
import { isTaskTerminal, TASK_VALID_TRANSITIONS } from '../dag/types.ts';
import { generateVersionId } from '../brand.ts';

/**
 * TaskInstance state machine — enforces valid transitions and tracks
 * retry numbers, timestamps, and exit status.
 *
 * This is a pure-logic module. All persistence is done by callers via
 * {@link SchedulerContext}.
 */

// ─── Factory ───

export interface CreateTaskInstanceInput {
  readonly id: TaskInstance['id'];
  readonly taskId: TaskInstance['taskId'];
  readonly dagRunId: TaskInstance['dagRunId'];
}

export function createTaskInstance(input: CreateTaskInstanceInput): TaskInstance {
  return {
    id: input.id,
    taskId: input.taskId,
    dagRunId: input.dagRunId,
    state: 'NONE',
    tryNumber: 0,
    version: generateVersionId(),
  };
}

// ─── State transitions ───

export function transitionState(ti: TaskInstance, to: TaskInstanceState): TaskInstance {
  if (!TASK_VALID_TRANSITIONS[ti.state].includes(to)) {
    if (isTaskTerminal(ti.state)) return ti;
    throw new Error(
      `Invalid TaskInstance transition: ${ti.state} → ${to} (instance ${ti.id})`,
    );
  }

  const now = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- state transition patch: only a subset of TaskInstance fields are mutated
  const patch: Partial<TaskInstance> = { state: to, version: generateVersionId() };

  switch (to) {
    case 'NONE':
    case 'SCHEDULED':
    case 'DEFERRED':
      break;
    case 'QUEUED':
      patch.startedAt = undefined;
      patch.completedAt = undefined;
      patch.error = undefined;
      break;
    case 'RUNNING':
      patch.startedAt = now;
      patch.completedAt = undefined;
      break;
    case 'SUCCESS':
    case 'FAILED':
      patch.completedAt = now;
      break;
    case 'UP_FOR_RETRY':
      patch.completedAt = now;
      break;
    case 'RESTARTING':
      patch.error = undefined;
      break;
    case 'SKIPPED':
    case 'UPSTREAM_FAILED':
      patch.completedAt = now;
      break;
    case 'REMOVED':
      patch.completedAt = ti.completedAt ?? now;
      break;
  }

  return { ...ti, ...patch };
}

// ─── Retry logic ───

export function shouldRetry(ti: TaskInstance, maxRetries: number): boolean {
  return ti.tryNumber < maxRetries;
}

export function transitionForRetry(ti: TaskInstance): TaskInstance {
  return transitionState(transitionState(ti, 'UP_FOR_RETRY'), 'QUEUED');
}

// ─── Completion helpers ───

export function markSuccess(ti: TaskInstance, output?: unknown): TaskInstance {
  return { ...transitionState(ti, 'SUCCESS'), ...(output !== undefined ? { output } : {}) };
}

export function markFailed(
  ti: TaskInstance,
  error: string,
  exitCode?: number,
): TaskInstance {
  return {
    ...transitionState(ti, 'FAILED'),
    error,
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}

export function markSkipped(ti: TaskInstance, reason?: string): TaskInstance {
  return { ...transitionState(ti, 'SKIPPED'), ...(reason ? { error: reason } : {}) };
}

export function markUpstreamFailed(ti: TaskInstance, reason?: string): TaskInstance {
  return {
    ...transitionState(ti, 'UPSTREAM_FAILED'),
    ...(reason ? { error: reason } : {}),
  };
}

export function markDeferred(ti: TaskInstance): TaskInstance {
  return transitionState(ti, 'DEFERRED');
}

// ─── Batch operations ───

export function transitionBatch(
  instances: readonly TaskInstance[],
  filter: (ti: TaskInstance) => boolean,
  to: TaskInstanceState,
): TaskInstance[] {
  return instances.map(ti => (filter(ti) ? transitionState(ti, to) : ti));
}
