import { describe, it, expect } from 'vitest';
import {
  createTaskInstance,
  transitionState,
  shouldRetry,
  markSuccess,
  markFailed,
  markSkipped,
  markUpstreamFailed,
  markDeferred,
  transitionBatch,
} from '../../../src/core/scheduler/task-instance.ts';
import {
  isTaskTerminal,
  TASK_VALID_TRANSITIONS,
} from '../../../src/core/dag/types.ts';
import type { TaskInstance, TaskInstanceId, TaskId, DagRunId } from '../../../src/core/dag/types.ts';

function makeTi(overrides: Partial<Pick<TaskInstance, 'state' | 'tryNumber' | 'startedAt' | 'completedAt' | 'error'>> = {}): TaskInstance {
  return {
    id: 'ti_test' as TaskInstanceId,
    taskId: 'task_1' as TaskId,
    dagRunId: 'dr_1' as DagRunId,
    state: 'NONE',
    tryNumber: 0,
    version: 'v1' as any,
    ...overrides,
  };
}

describe('TaskInstance state machine', () => {
  describe('createTaskInstance', () => {
    it('creates in NONE state with tryNumber 0', () => {
      const ti = createTaskInstance({
        id: 'ti_1' as TaskInstanceId,
        taskId: 't1' as TaskId,
        dagRunId: 'dr1' as DagRunId,
      });
      expect(ti.state).toBe('NONE');
      expect(ti.tryNumber).toBe(0);
    });
  });

  describe('transitionState', () => {
    it('NONE → SCHEDULED', () => {
      const ti = makeTi();
      const r = transitionState(ti, 'SCHEDULED');
      expect(r.state).toBe('SCHEDULED');
    });

    it('SCHEDULED → QUEUED', () => {
      const ti = makeTi({ state: 'SCHEDULED' });
      const r = transitionState(ti, 'QUEUED');
      expect(r.state).toBe('QUEUED');
    });

    it('RUNNING → SUCCESS sets completedAt', () => {
      const ti = makeTi({ state: 'RUNNING', startedAt: 1000 });
      const r = transitionState(ti, 'SUCCESS');
      expect(r.state).toBe('SUCCESS');
      expect(r.completedAt).toBeGreaterThan(0);
    });

    it('RUNNING → FAILED sets completedAt', () => {
      const ti = makeTi({ state: 'RUNNING', startedAt: 1000 });
      const r = transitionState(ti, 'FAILED');
      expect(r.state).toBe('FAILED');
      expect(r.completedAt).toBeGreaterThan(0);
    });

    it('returns unchanged for terminal (non-throwing guard)', () => {
      const ti = makeTi({ state: 'SUCCESS' });
      const r = transitionState(ti, 'RUNNING');
      expect(r).toBe(ti); // terminal guard returns unchanged
    });

    it('returns unchanged for terminal state transitions', () => {
      const ti = makeTi({ state: 'SUCCESS' });
      // Already terminal — transitionState should throw, but our guard returns unchanged
      // Actually, terminal states have no valid transitions, so it will throw
      // But the guard: if (!VALID_TRANSITIONS[ti.state]?.includes(to)) ... if (isTaskTerminal) return ti
      const r = transitionState(ti, 'RUNNING');
      expect(r).toBe(ti); // unchanged because terminal
    });
  });

  describe('transition rules', () => {
    it('all 12 states have entries in VALID_TRANSITIONS', () => {
      const states = ['NONE', 'SCHEDULED', 'QUEUED', 'RUNNING', 'SUCCESS', 'FAILED', 'UP_FOR_RETRY', 'SKIPPED', 'UPSTREAM_FAILED', 'DEFERRED', 'RESTARTING', 'REMOVED'];
      for (const s of states) {
        expect(TASK_VALID_TRANSITIONS[s as any]).toBeDefined();
      }
    });

    it('terminal states have no outgoing transitions', () => {
      expect(TASK_VALID_TRANSITIONS.SUCCESS).toEqual([]);
      expect(TASK_VALID_TRANSITIONS.FAILED).toEqual([]);
      expect(TASK_VALID_TRANSITIONS.SKIPPED).toEqual([]);
      expect(TASK_VALID_TRANSITIONS.UPSTREAM_FAILED).toEqual([]);
      expect(TASK_VALID_TRANSITIONS.REMOVED).toEqual([]);
    });
  });

  describe('shouldRetry', () => {
    it('returns true when tryNumber < maxRetries', () => {
      const ti = makeTi({ tryNumber: 0 });
      expect(shouldRetry(ti, 3)).toBe(true);
    });
    it('returns false when tryNumber >= maxRetries', () => {
      const ti = makeTi({ tryNumber: 3 });
      expect(shouldRetry(ti, 3)).toBe(false);
    });
  });

  describe('convenience helpers', () => {
    it('markSuccess transitions to SUCCESS with output', () => {
      const ti = makeTi({ state: 'RUNNING', startedAt: 1000 });
      const r = markSuccess(ti, { data: 'ok' });
      expect(r.state).toBe('SUCCESS');
      expect(r.output).toEqual({ data: 'ok' });
    });

    it('markFailed transitions to FAILED with error', () => {
      const ti = makeTi({ state: 'RUNNING', startedAt: 1000 });
      const r = markFailed(ti, 'something broke', 1);
      expect(r.state).toBe('FAILED');
      expect(r.error).toBe('something broke');
      expect(r.exitCode).toBe(1);
    });

    it('markSkipped transitions to SKIPPED', () => {
      const ti = makeTi({ state: 'SCHEDULED' });
      const r = markSkipped(ti, 'condition false');
      expect(r.state).toBe('SKIPPED');
      expect(r.error).toBe('condition false');
    });

    it('markUpstreamFailed transitions to UPSTREAM_FAILED', () => {
      const ti = makeTi({ state: 'SCHEDULED' });
      const r = markUpstreamFailed(ti, 'dep failed');
      expect(r.state).toBe('UPSTREAM_FAILED');
    });

    // Regression: NONE→SKIPPED and NONE→UPSTREAM_FAILED (ISSUE-00086)
    it('NONE → SKIPPED via markSkipped', () => {
      const ti = makeTi({ state: 'NONE' });
      const r = markSkipped(ti, 'branch skipped');
      expect(r.state).toBe('SKIPPED');
    });

    it('NONE → UPSTREAM_FAILED via markUpstreamFailed', () => {
      const ti = makeTi({ state: 'NONE' });
      const r = markUpstreamFailed(ti, 'upstream dep failed');
      expect(r.state).toBe('UPSTREAM_FAILED');
    });

    it('markDeferred transitions to DEFERRED', () => {
      const ti = makeTi({ state: 'RUNNING' });
      const r = markDeferred(ti);
      expect(r.state).toBe('DEFERRED');
    });
  });

  describe('transitionBatch', () => {
    it('transitions matching tasks in batch', () => {
      const tis = [
        makeTi({ state: 'SCHEDULED' }),
        makeTi({ state: 'SCHEDULED' }),
        makeTi({ state: 'RUNNING' }),
      ];
      const result = transitionBatch(tis, t => t.state === 'SCHEDULED', 'QUEUED');
      expect(result[0]!.state).toBe('QUEUED');
      expect(result[1]!.state).toBe('QUEUED');
      expect(result[2]!.state).toBe('RUNNING'); // didn't match
    });
  });
});
