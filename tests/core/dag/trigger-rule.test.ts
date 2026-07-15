import { describe, it, expect } from 'vitest';
import { evaluateTriggerRule } from '../../../src/core/dag/trigger-rule.ts';
import type { TaskInstanceState, TriggerRule } from '../../../src/core/dag/types.ts';
import { TERMINAL_TASK_STATES } from '../../../src/core/dag/types.ts';

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
    it('returns true for all 9 rules when upstream is empty', () => {
      const rules: TriggerRule[] = ['all_success', 'all_failed', 'all_done', 'one_success', 'one_failed', 'none_failed', 'none_skipped', 'none_failed_min_one_success', 'always'];
      for (const rule of rules) {
        expect(evaluateTriggerRule(rule, [])).toBe(true);
      }
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // 穷举真值表 (ISSUE-00018 / ISSUE-00070)
  // ═════════════════════════════════════════════════════════════════════

  const ALL_STATES: TaskInstanceState[] = [
    'NONE', 'SCHEDULED', 'QUEUED', 'RUNNING',
    'SUCCESS', 'FAILED', 'UP_FOR_RETRY', 'SKIPPED',
    'UPSTREAM_FAILED', 'DEFERRED', 'RESTARTING', 'REMOVED',
  ];
  const FAILED_LIKE: TaskInstanceState[] = ['FAILED', 'UPSTREAM_FAILED'];

  describe('穷举真值表 — 9 规则 × 12 单状态', () => {
    const ruleFns: Record<TriggerRule, (s: TaskInstanceState) => boolean> = {
      always: () => true,
      all_success: s => s === 'SUCCESS',
      all_failed: s => FAILED_LIKE.includes(s),
      all_done: s => TERMINAL_TASK_STATES.has(s),
      one_success: s => s === 'SUCCESS',
      one_failed: s => FAILED_LIKE.includes(s),
      none_failed: s => !FAILED_LIKE.includes(s),
      none_skipped: s => s !== 'SKIPPED',
      none_failed_min_one_success: s => !FAILED_LIKE.includes(s) && s === 'SUCCESS',
    };

    for (const [rule, fn] of Object.entries(ruleFns)) {
      for (const state of ALL_STATES) {
        const expected = fn(state);
        it(`${rule}(${state}) === ${String(expected)}`, () => {
          expect(evaluateTriggerRule(rule as TriggerRule, [state])).toBe(expected);
        });
      }
    }
  });

  describe('穷举真值表 — 9 规则 × 双状态组合', () => {
    it('all_success: only ALL SUCCESS → true', () => {
      expect(evaluateTriggerRule('all_success', ['SUCCESS', 'SUCCESS'])).toBe(true);
      expect(evaluateTriggerRule('all_success', ['SUCCESS', 'FAILED'])).toBe(false);
    });
    it('all_failed: only ALL FAILED/UPSTREAM_FAILED → true', () => {
      expect(evaluateTriggerRule('all_failed', ['FAILED', 'FAILED'])).toBe(true);
      expect(evaluateTriggerRule('all_failed', ['FAILED', 'SUCCESS'])).toBe(false);
    });
    it('all_done: ALL terminal → true', () => {
      expect(evaluateTriggerRule('all_done', ['SUCCESS', 'FAILED'])).toBe(true);
      expect(evaluateTriggerRule('all_done', ['SUCCESS', 'RUNNING'])).toBe(false);
    });
    it('one_success: ≥1 SUCCESS → true', () => {
      expect(evaluateTriggerRule('one_success', ['FAILED', 'SUCCESS'])).toBe(true);
      expect(evaluateTriggerRule('one_success', ['FAILED', 'FAILED'])).toBe(false);
    });
    it('one_failed: ≥1 FAILED/UPSTREAM_FAILED → true', () => {
      expect(evaluateTriggerRule('one_failed', ['SUCCESS', 'FAILED'])).toBe(true);
      expect(evaluateTriggerRule('one_failed', ['SUCCESS', 'SUCCESS'])).toBe(false);
    });
    it('none_failed: 0 FAILED/UPSTREAM_FAILED → true', () => {
      expect(evaluateTriggerRule('none_failed', ['SUCCESS', 'RUNNING'])).toBe(true);
      expect(evaluateTriggerRule('none_failed', ['SUCCESS', 'FAILED'])).toBe(false);
    });
    it('none_skipped: 0 SKIPPED → true', () => {
      expect(evaluateTriggerRule('none_skipped', ['SUCCESS', 'FAILED'])).toBe(true);
      expect(evaluateTriggerRule('none_skipped', ['SUCCESS', 'SKIPPED'])).toBe(false);
    });
    it('none_failed_min_one_success: no FAILED AND ≥1 SUCCESS', () => {
      expect(evaluateTriggerRule('none_failed_min_one_success', ['SUCCESS', 'SKIPPED'])).toBe(true);
      expect(evaluateTriggerRule('none_failed_min_one_success', ['SUCCESS', 'FAILED'])).toBe(false);
      expect(evaluateTriggerRule('none_failed_min_one_success', ['SKIPPED'])).toBe(false);
    });
    it('always: always true', () => {
      expect(evaluateTriggerRule('always', ['FAILED', 'FAILED'])).toBe(true);
    });
  });

  describe('互斥规则对 — 不同时 true（空上游时互斥失效，行为已标注）', () => {
    // none_failed 与 one_failed 对非空输入是精确逻辑否定，必互斥
    it('none_failed vs one_failed: 非空上游互斥', () => {
      const mixes: TaskInstanceState[][] = [
        ['FAILED'], ['UPSTREAM_FAILED'], ['FAILED', 'SUCCESS'],
        ['SUCCESS', 'SKIPPED'], ['RUNNING'],
      ];
      for (const states of mixes) {
        expect(evaluateTriggerRule('none_failed', states) !== evaluateTriggerRule('one_failed', states)).toBe(true);
      }
    });
    // 空上游时两者均为 true（line 24 提前返回），互斥被破坏
    it('none_failed vs one_failed: 空上游时互斥失效（两者都 true）', () => {
      expect(evaluateTriggerRule('none_failed', [])).toBe(true);
      expect(evaluateTriggerRule('one_failed', [])).toBe(true);
    });
    it('none_failed vs all_failed: 非空时不同时 true', () => {
      expect(evaluateTriggerRule('none_failed', ['FAILED', 'FAILED'])).toBe(false);
      expect(evaluateTriggerRule('all_failed', ['FAILED', 'FAILED'])).toBe(true);
      expect(evaluateTriggerRule('none_failed', ['SUCCESS', 'SUCCESS'])).toBe(true);
      expect(evaluateTriggerRule('all_failed', ['SUCCESS', 'SUCCESS'])).toBe(false);
    });
  });
});
