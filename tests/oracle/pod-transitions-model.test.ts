/**
 * Model-based oracle for PodTransition — 1:1 port of pod-transitions NRI (Python).
 *
 * Fast-check modelRun differential between the NRI (Naive Reference
 * Implementation) and the real transitionPod().
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { transitionPod } from '../../src/core/pod/transitions.ts';
import type { PodAction } from '../../src/core/pod/transitions.ts';
import type { PodEntity, PodPhase, PodCondition, PodSpec, PodRuntime } from '../../src/core/pod/types.ts';

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

const ALL_PHASES: readonly PodPhase[] = ['Pending', 'Running', 'Succeeded', 'Failed', 'Unknown'];

const TERMINAL: ReadonlySet<PodPhase> = new Set(['Succeeded', 'Failed']);

const EXIT_TERMINAL: ReadonlySet<string> = new Set([
  'Start', 'Restart', 'Update', 'Provision',
  'ForceDelete', 'MarkFailed', 'MarkSucceeded', 'MarkExpired',
]);

const API_ACTION_NAMES: readonly string[] = [
  'Provision', 'Start', 'Stop', 'Restart', 'Update', 'Terminate',
  'ForceDelete', 'MarkFailed', 'MarkSucceeded', 'MarkExpired',
];

const CONTROL_CONDITION_TYPE = 'DisruptionTarget';

// ═══════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════

const MINIMAL_SPEC: PodSpec = {
  metadata: { name: 'test' },
  spec: { containers: [], restartPolicy: 'Never' },
};

function makePod(phase: PodPhase, conditions?: readonly PodCondition[]): PodEntity {
  return {
    podId: 'test-pod' as PodEntity['podId'],
    name: 'test',
    spec: MINIMAL_SPEC,
    phase,
    network: {},
    containers: [],
    conditions: conditions ?? [],
    events: [],
    createdAt: 0,
    updatedAt: 0,
    version: 'v1' as PodEntity['version'],
  };
}

function makePodRuntime(phase: PodPhase): PodRuntime {
  return {
    podId: 'test-pod' as PodRuntime['podId'],
    providerId: 'p',
    name: 'test',
    phase,
    conditions: [],
    containers: [],
    volumes: [],
    events: [],
    network: {},
  };
}

function createApiAction(actionName: string): PodAction {
  switch (actionName) {
    case 'Provision':
      return { type: 'Provision', spec: MINIMAL_SPEC, providerId: 'p', network: {} };
    case 'Start':
      return { type: 'Start' };
    case 'Stop':
      return { type: 'Stop' };
    case 'Restart':
      return { type: 'Restart' };
    case 'Update':
      return { type: 'Update', spec: MINIMAL_SPEC };
    case 'Terminate':
      return { type: 'Terminate' };
    case 'ForceDelete':
      return { type: 'ForceDelete' };
    case 'MarkFailed':
      return { type: 'MarkFailed', reason: 'test' };
    case 'MarkSucceeded':
      return { type: 'MarkSucceeded' };
    case 'MarkExpired':
      return { type: 'MarkExpired' };
    default:
      throw new Error(`Unknown action: ${actionName}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// NRI — Naive Reference Implementation
// (ported from .oracle/tests/nri_pod_transitions.py)
//
// Structural differences from TS (transitionPod):
//   1. Returns phase unchanged for rejected transitions (TS throws Error)
//   2. NRI uses action-name strings; TS uses PodAction discriminated unions
//   3. ProviderSync sets phase directly; TS UpdateFromProvider reads phase
//      from the PodRuntime payload
// ═══════════════════════════════════════════════════════════════

function nriTransition(phase: PodPhase, actionName: string): PodPhase {
  // ProviderSync is not an API action — handled separately
  if (actionName === 'UpdateFromProvider') return phase;

  // P1: Terminal absorption — non-exit actions leave phase unchanged
  if (TERMINAL.has(phase) && !EXIT_TERMINAL.has(actionName)) return phase;

  switch (actionName) {
    case 'Provision':
      return 'Pending';
    case 'Start':
      return TERMINAL.has(phase) ? 'Running' : phase;
    case 'Stop':
      return phase === 'Running' ? 'Succeeded' : phase;
    case 'Restart':
      return 'Running';
    case 'Update':
      return 'Running';
    case 'Terminate':
      return phase;
    case 'ForceDelete':
    case 'MarkFailed':
    case 'MarkExpired':
      return 'Failed';
    case 'MarkSucceeded':
      return 'Succeeded';
    default:
      return phase;
  }
}

/**
 * Condition evolution model (NRI).
 *
 * Provision → fresh pod (no inherited conditions).
 * All other actions → filterControlConditions preserves DisruptionTarget.
 */
function nriConditionsAfter(actionName: string, conditions: readonly PodCondition[]): PodCondition[] {
  if (actionName === 'Provision') return [];
  return conditions.filter(c => c.type === CONTROL_CONDITION_TYPE);
}

// ═══════════════════════════════════════════════════════════════
// Safety invariants
// ═══════════════════════════════════════════════════════════════

/** P1: Terminal states absorb non-exit actions. */
function checkP1_terminalAbsorb(prev: PodPhase, curr: PodPhase, actionName: string): boolean {
  if (!TERMINAL.has(prev)) return true;
  if (EXIT_TERMINAL.has(actionName)) return true;
  return TERMINAL.has(curr);
}

/** P4: DisruptionTarget conditions survive non-Provision transitions. */
function checkP4_dtPreserved(
  original: readonly PodCondition[],
  result: readonly PodCondition[],
  actionName: string,
): boolean {
  if (actionName === 'Provision') return true;
  const originalDT = original.filter(c => c.type === CONTROL_CONDITION_TYPE);
  if (originalDT.length === 0) return true;
  const resultTypes = new Set(result.map(c => c.type));
  return originalDT.every(c => resultTypes.has(c.type));
}

// ═══════════════════════════════════════════════════════════════
// Buggy mutation variants (for invariant sensitivity / shrinking)
// ═══════════════════════════════════════════════════════════════

/** Violates P1: Stop from terminal goes to Running ("undead terminal"). */
function buggy_undeadTerminal(phase: PodPhase, actionName: string): PodPhase {
  if (actionName === 'Stop' && TERMINAL.has(phase)) return 'Running';
  return nriTransition(phase, actionName);
}

/** Violates P4: UpdateFromProvider drops all DisruptionTarget conditions. */
function buggy_dtDropped(actionName: string, _conditions: readonly PodCondition[]): PodCondition[] {
  if (actionName === 'UpdateFromProvider') return [];
  return nriConditionsAfter(actionName, _conditions);
}

// ═══════════════════════════════════════════════════════════════
// ModelRun types
// ═══════════════════════════════════════════════════════════════

interface M {
  state: PodPhase;
}

class R {
  pod: PodEntity;
  constructor(phase: PodPhase) {
    this.pod = makePod(phase);
  }
}

type NriTrigger =
  | { kind: 'Api'; action: string }
  | { kind: 'ProviderSync'; targetPhase: PodPhase };

/**
 * Command: apply a PodAction to the real system and the matching NRI trigger
 * to the model, then check that both agree on the resulting phase.
 *
 * Known divergence: NRI returns phase unchanged for invalid transitions while
 * TS throws Error.  Handled transparently — if TS throws and NRI also says
 * unchanged, both are consistent (no model update needed).
 */
class PodCmd implements fc.Command<M, R> {
  constructor(
    readonly trigger: NriTrigger,
    readonly action: PodAction,
  ) {}

  check(_m: Readonly<M>): boolean {
    return true; // all transitions are valid test cases
  }

  run(m: M, r: R): void {
    const from = m.state;
    const nri = this.trigger.kind === 'Api'
      ? nriTransition(from, this.trigger.action)
      : this.trigger.targetPhase;

    try {
      const ts = transitionPod(r.pod, this.action);
      // TS succeeded — must agree with NRI
      expect(ts.phase).toBe(nri);
      // Advance both model and real for the next command
      m.state = ts.phase;
      r.pod = ts;
    } catch {
      // TS threw — NRI must also say unchanged
      if (nri !== from) {
        throw new Error(
          `DIVERGENCE: TS rejected ${from}→${this.trigger.kind === 'Api' ? this.trigger.action : 'ProviderSync'} ` +
          `but NRI would change to ${nri}`,
        );
      }
      // else: both agree state is unchanged — no update needed
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Command arbitraries
// ═══════════════════════════════════════════════════════════════

const apiCmdArb: fc.Arbitrary<fc.Command<M, R>> = fc
  .constantFrom(...API_ACTION_NAMES)
  .map(actionName => new PodCmd(
    { kind: 'Api', action: actionName },
    createApiAction(actionName),
  ));

const providerSyncCmdArb: fc.Arbitrary<fc.Command<M, R>> = fc
  .constantFrom(...ALL_PHASES)
  .map(targetPhase => new PodCmd(
    { kind: 'ProviderSync', targetPhase },
    { type: 'UpdateFromProvider' as const, status: makePodRuntime(targetPhase) },
  ));

const allCmdArb: fc.Arbitrary<fc.Command<M, R>> = fc.oneof(
  { arbitrary: apiCmdArb, weight: 10 },
  { arbitrary: providerSyncCmdArb, weight: 2 },
);

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe('PodTransition NRI model vs TS', () => {
  // ─── 5×10 transition matrix ───

  describe('NRI 5×10 transition matrix', () => {
    it('all 50 cells: NRI and TS agree on final phase', () => {
      for (const phase of ALL_PHASES) {
        for (const actionName of API_ACTION_NAMES) {
          const nri = nriTransition(phase, actionName);
          const pod = makePod(phase);
          const action = createApiAction(actionName);

          try {
            const ts = transitionPod(pod, action);
            // TS succeeded — must agree with NRI
            expect(ts.phase).toBe(nri);
          } catch {
            // TS threw — NRI must return unchanged
            expect(nri).toBe(phase);
          }
        }
      }
    });
  });

  // ─── modelRun differential ───

  describe('modelRun differential (NRI vs TS)', () => {
    it('agrees on all random transition sequences from Pending', () => {
      fc.assert(
        fc.property(
          fc.commands([allCmdArb]),
          (cmds) => {
            fc.modelRun(
              () => ({ model: { state: 'Pending' as PodPhase }, real: new R('Pending') }),
              cmds,
            );
          },
        ),
        { numRuns: 1000 },
      );
    });

    it('agrees from Running', () => {
      fc.assert(
        fc.property(
          fc.commands([allCmdArb]),
          (cmds) => {
            fc.modelRun(
              () => ({ model: { state: 'Running' as PodPhase }, real: new R('Running') }),
              cmds,
            );
          },
        ),
        { numRuns: 500 },
      );
    });

    it('agrees from Succeeded (terminal)', () => {
      fc.assert(
        fc.property(
          fc.commands([allCmdArb]),
          (cmds) => {
            fc.modelRun(
              () => ({ model: { state: 'Succeeded' as PodPhase }, real: new R('Succeeded') }),
              cmds,
            );
          },
        ),
        { numRuns: 500 },
      );
    });
  });

  // ─── Terminal absorption (P1) ───

  describe('terminal absorption (P1)', () => {
    it('modelRun from terminal: non-exit sequences leave phase in terminal', () => {
      fc.assert(
        fc.property(
          fc.commands([allCmdArb], { maxCommands: 10 }),
          (cmds) => {
            fc.modelRun(
              () => ({ model: { state: 'Succeeded' as PodPhase }, real: new R('Succeeded') }),
              cmds,
            );
          },
        ),
        { numRuns: 300 },
      );
    });

    it('all terminal states absorb non-exit actions (explicit 5×10)', () => {
      for (const terminalPhase of ['Succeeded', 'Failed'] as const) {
        for (const actionName of API_ACTION_NAMES) {
          const nri = nriTransition(terminalPhase, actionName);
          if (!EXIT_TERMINAL.has(actionName)) {
            // Stop + Terminate are the only API actions NOT in EXIT_TERMINAL
            expect(nri).toBe(terminalPhase);
          }
        }
      }
    });

    it('TS terminal states absorb non-exit actions', () => {
      for (const terminalPhase of ['Succeeded', 'Failed'] as const) {
        for (const actionName of API_ACTION_NAMES) {
          if (EXIT_TERMINAL.has(actionName)) continue;
          const pod = makePod(terminalPhase);
          const action = createApiAction(actionName);
          if (actionName === 'Terminate') {
            // Terminate keeps phase unchanged, does not throw
            const result = transitionPod(pod, action);
            expect(result.phase).toBe(terminalPhase);
          } else {
            // Stop from terminal throws (absorbed)
            expect(() => transitionPod(pod, action)).toThrow();
          }
        }
      }
    });

    it('P1 invariant detects buggy_undeadTerminal', () => {
      for (const phase of ALL_PHASES) {
        if (!TERMINAL.has(phase)) continue;
        for (const actionName of API_ACTION_NAMES) {
          const nri = nriTransition(phase, actionName);
          const buggy = buggy_undeadTerminal(phase, actionName);
          if (nri !== buggy) {
            // Mutation diverged from NRI — P1 must flag it
            expect(checkP1_terminalAbsorb(phase, buggy, actionName)).toBe(false);
            return; // one detection is enough
          }
        }
      }
      expect.unreachable('buggy_undeadTerminal never diverged from NRI');
    });
  });

  // ─── Bug detection + shrinking ───

  describe('bug detection and shrinking', () => {
    it('property-based test detects buggy_undeadTerminal with shrinking', () => {
      // fc.check returns a result instead of throwing, so we can inspect
      // shrink metadata.
      // Use fc.nat + map for shrinkable indices. Fixed seed (`seed: 5`)
      // makes the test deterministic — seed 5 triggers exactly 1 shrink step
      // from the initial random counterexample to the minimal (Succeeded, Stop).
      const result = fc.check(
        fc.property(
          fc.nat({ max: ALL_PHASES.length - 1 }).map(i => ALL_PHASES[i]),
          fc.nat({ max: API_ACTION_NAMES.length - 1 }).map(i => API_ACTION_NAMES[i]),
          (phase, actionName) => {
            const buggy = buggy_undeadTerminal(phase, actionName);
            // This assertion fails for (Succeeded, Stop) and (Failed, Stop)
            // because undead returns Running (non-terminal) from a terminal
            // state via Stop, which violates P1.
            expect(checkP1_terminalAbsorb(phase, buggy, actionName)).toBe(true);
          },
        ),
        { numRuns: 200, seed: 5 },
      );

      expect(result.failed).toBe(true);
      expect(result.numShrinks).toBeGreaterThan(0);
      expect(result.counterexample).not.toBeNull();
    });
  });

  // ─── Conditions model (P4) ───

  describe('conditions model (P4)', () => {
    it('DisruptionTarget survives all non-Provision API transitions', () => {
      const originals: PodCondition[] = [
        { type: 'DisruptionTarget', status: 'True', lastTransitionTime: 0 },
        { type: 'PodScheduled', status: 'True', lastTransitionTime: 0 },
      ];

      for (const phase of ALL_PHASES) {
        for (const actionName of API_ACTION_NAMES) {
          if (actionName === 'Provision') continue;
          const pod = makePod(phase, originals);
          const action = createApiAction(actionName);

          try {
            const result = transitionPod(pod, action);
            expect(checkP4_dtPreserved(originals, result.conditions, actionName)).toBe(true);
          } catch {
            // TS threw before modifying conditions — P4 holds trivially
          }
        }
      }
    });

    it('UpdateFromProvider preserves DisruptionTarget', () => {
      const originals: PodCondition[] = [
        { type: 'DisruptionTarget', status: 'True', lastTransitionTime: 0 },
      ];
      const pod = makePod('Running', originals);
      const action: PodAction = { type: 'UpdateFromProvider', status: makePodRuntime('Running') };
      const result = transitionPod(pod, action);
      expect(checkP4_dtPreserved(originals, result.conditions, 'UpdateFromProvider')).toBe(true);
    });

    it('Provision creates fresh pod with no inherited conditions', () => {
      const originals: PodCondition[] = [
        { type: 'DisruptionTarget', status: 'True', lastTransitionTime: 0 },
      ];
      const pod = makePod('Running', originals);
      const action: PodAction = { type: 'Provision', spec: MINIMAL_SPEC, providerId: 'p', network: {} };
      const result = transitionPod(pod, action);
      const dtInResult = result.conditions.filter(c => c.type === 'DisruptionTarget');
      expect(dtInResult).toHaveLength(0);
    });

    it('P4 invariant detects buggy_dtDropped', () => {
      const conditions: PodCondition[] = [
        { type: 'DisruptionTarget', status: 'True', lastTransitionTime: 0 },
      ];
      const buggy = buggy_dtDropped('UpdateFromProvider', conditions);
      expect(checkP4_dtPreserved(conditions, buggy, 'UpdateFromProvider')).toBe(false);
    });
  });
});
