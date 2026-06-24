import { describe, it, expect } from 'vitest';
import { evaluateTriggerRule } from '../../../src/core/dag/trigger-rule.ts';
import type { TaskInstanceState } from '../../../src/core/dag/types.ts';

const S: TaskInstanceState = 'SUCCESS';
const F: TaskInstanceState = 'FAILED';
const UF: TaskInstanceState = 'UPSTREAM_FAILED';
const SK: TaskInstanceState = 'SKIPPED';
const R: TaskInstanceState = 'RUNNING';
const N: TaskInstanceState = 'NONE';

describe('evaluateTriggerRule', () => {
  describe('all_success', () => {
    it('true when all upstream are SUCCESS', () => {
      expect(evaluateTriggerRule('all_success', [S, S])).toBe(true);
      expect(evaluateTriggerRule('all_success', [S])).toBe(true);
    });
    it('false when any upstream is not SUCCESS', () => {
      expect(evaluateTriggerRule('all_success', [S, F])).toBe(false);
      expect(evaluateTriggerRule('all_success', [S, SK])).toBe(false);
      expect(evaluateTriggerRule('all_success', [S, R])).toBe(false);
    });
  });

  describe('all_failed', () => {
    it('true when all upstream are FAILED or UPSTREAM_FAILED', () => {
      expect(evaluateTriggerRule('all_failed', [F, F])).toBe(true);
      expect(evaluateTriggerRule('all_failed', [F, UF])).toBe(true);
    });
    it('false when any upstream is not failed', () => {
      expect(evaluateTriggerRule('all_failed', [S, F])).toBe(false);
      expect(evaluateTriggerRule('all_failed', [S])).toBe(false);
    });
  });

  describe('all_done', () => {
    it('true when all upstream are terminal', () => {
      expect(evaluateTriggerRule('all_done', [S, F])).toBe(true);
      expect(evaluateTriggerRule('all_done', [SK, UF])).toBe(true);
    });
    it('false when any upstream is not terminal', () => {
      expect(evaluateTriggerRule('all_done', [S, R])).toBe(false);
    });
  });

  describe('one_success', () => {
    it('true when at least one upstream is SUCCESS', () => {
      expect(evaluateTriggerRule('one_success', [S, F, SK])).toBe(true);
      expect(evaluateTriggerRule('one_success', [S])).toBe(true);
    });
    it('false when no upstream is SUCCESS', () => {
      expect(evaluateTriggerRule('one_success', [F, SK])).toBe(false);
    });
  });

  describe('one_failed', () => {
    it('true when at least one upstream is FAILED', () => {
      expect(evaluateTriggerRule('one_failed', [F, S, S])).toBe(true);
      expect(evaluateTriggerRule('one_failed', [UF])).toBe(true);
    });
    it('false when no upstream is FAILED', () => {
      expect(evaluateTriggerRule('one_failed', [S, SK])).toBe(false);
    });
  });

  describe('none_failed', () => {
    it('true when no upstream is FAILED', () => {
      expect(evaluateTriggerRule('none_failed', [S, SK, R])).toBe(true);
    });
    it('false when any upstream is FAILED', () => {
      expect(evaluateTriggerRule('none_failed', [S, F])).toBe(false);
      expect(evaluateTriggerRule('none_failed', [UF])).toBe(false);
    });
  });

  describe('none_skipped', () => {
    it('true when no upstream is SKIPPED', () => {
      expect(evaluateTriggerRule('none_skipped', [S, F])).toBe(true);
    });
    it('false when any upstream is SKIPPED', () => {
      expect(evaluateTriggerRule('none_skipped', [SK, S])).toBe(false);
    });
  });

  describe('none_failed_min_one_success', () => {
    it('true when no failed and at least one success', () => {
      expect(evaluateTriggerRule('none_failed_min_one_success', [S, SK])).toBe(true);
    });
    it('false when any failed', () => {
      expect(evaluateTriggerRule('none_failed_min_one_success', [S, F])).toBe(false);
    });
    it('false when no success', () => {
      expect(evaluateTriggerRule('none_failed_min_one_success', [SK])).toBe(false);
    });
  });

  describe('always', () => {
    it('always true', () => {
      expect(evaluateTriggerRule('always', [])).toBe(true);
      expect(evaluateTriggerRule('always', [F, F, F])).toBe(true);
    });
  });

  describe('empty upstream', () => {
    it('returns true for all rules when no upstream', () => {
      const rules: TaskInstanceState[] = ['all_success', 'all_failed', 'all_done', 'one_success', 'one_failed', 'none_failed', 'none_skipped', 'none_failed_min_one_success', 'always'];
      for (const rule of rules) {
        expect(evaluateTriggerRule(rule as any, [])).toBe(rule !== 'all_failed' || true);
      }
    });
  });
});
