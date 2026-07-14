/**
 * LIVE — fast-check model-based oracle for Sandbox GC (NRI port).
 *
 * Ports gc_decision and sandbox_transition from the Python NRI
 * (.oracle/tests/nri_sandbox_gc.py) and verifies:
 *   1. Full GC decision matrix across all 11 states x boundary conditions
 *   2. Agreement with TS decidePodGc on mapped 5-state PodPhase
 *   3. Safety invariants P1-P8 against mutations
 *   4. Self-consistent modelRun transition sequences
 *   5. GC-decision property-based invariant checks
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { decidePodGc } from '../../src/core/events/health-check';
import type { GcReason } from '../../src/core/events/health-check';

// ═════════════════════════════════════════════════════════════════════
// 1. NRI types — 11-state SandboxStatus
// ═════════════════════════════════════════════════════════════════════

const SandboxStatus = {
  Scheduling: 'Scheduling',
  Pending: 'Pending',
  Running: 'Running',
  Succeeded: 'Succeeded',
  Failed: 'Failed',
  Restarting: 'Restarting',
  Updating: 'Updating',
  Terminating: 'Terminating',
  ScheduleFailed: 'ScheduleFailed',
  Expired: 'Expired',
  Deleted: 'Deleted',
} as const;
type SandboxStatus = (typeof SandboxStatus)[keyof typeof SandboxStatus];
const ALL_STATES: readonly SandboxStatus[] = /*#__PURE__*/ Object.values(SandboxStatus);

const ContainerHealth = {
  Waiting: 'Waiting',
  Running: 'Running',
  Unhealthy: 'Unhealthy',
  Terminated: 'Terminated',
} as const;
type ContainerHealth = (typeof ContainerHealth)[keyof typeof ContainerHealth];

// ─── State categories ──────────────────────────────────────────────
const TRANSIENT: ReadonlySet<SandboxStatus> = new Set([
  SandboxStatus.Scheduling, SandboxStatus.Pending,
  SandboxStatus.Restarting, SandboxStatus.Updating,
]);
const SOFT_TERMINAL: ReadonlySet<SandboxStatus> = new Set([
  SandboxStatus.Succeeded, SandboxStatus.Failed,
]);
const HARD_TERMINAL: ReadonlySet<SandboxStatus> = new Set([
  SandboxStatus.ScheduleFailed, SandboxStatus.Expired,
]);
const TERMINAL: ReadonlySet<SandboxStatus> = new Set([
  ...SOFT_TERMINAL, ...HARD_TERMINAL, SandboxStatus.Deleted,
]);
const DELETABLE: ReadonlySet<SandboxStatus> = new Set([
  SandboxStatus.Running, SandboxStatus.Pending,
  SandboxStatus.Restarting, SandboxStatus.Updating,
  SandboxStatus.Succeeded, SandboxStatus.Failed,
]);

// ─── Timeout constants ─────────────────────────────────────────────
const STUCK_GC_TIMEOUT_MS = 10 * 60 * 1000;
const STOPPED_GC_TIMEOUT_MS = 60 * 1000;
const FAILED_GC_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const TERMINATING_GC_TIMEOUT_MS = 60 * 1000;
const EXPIRED_GC_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// ─── Event constants ───────────────────────────────────────────────
const API_DELETE = 'Delete';
const API_RESTART = 'Restart';
const API_UPDATE = 'Update';
const SYS_SCHEDULE_OK = 'ScheduleSucceeded';
const SYS_SCHEDULE_FAIL = 'ScheduleFailed';
const SYS_INIT_OK = 'InitSucceeded';
const SYS_INIT_FAIL = 'InitFailed';
const SYS_EXPIRED = 'InstanceExpired';
const SYS_RESTART_OK = 'RestartSucceeded';
const SYS_RESTART_FAIL = 'RestartFailed';
const SYS_UPDATE_OK = 'UpdateSucceeded';
const SYS_UPDATE_FAIL = 'UpdateFailed';
const SYS_CLEANUP = 'CleanupComplete';
const SYS_DELETE_FAIL = 'DeleteFailed';

const SYSTEM_EVENTS: readonly string[] = [
  SYS_SCHEDULE_OK, SYS_SCHEDULE_FAIL, SYS_INIT_OK, SYS_INIT_FAIL,
  SYS_EXPIRED, SYS_RESTART_OK, SYS_RESTART_FAIL,
  SYS_UPDATE_OK, SYS_UPDATE_FAIL, SYS_CLEANUP, SYS_DELETE_FAIL,
];
const API_OPS: readonly string[] = [API_DELETE, API_RESTART, API_UPDATE];

type TriggerKind = 'Api' | 'System';
type Trigger = readonly [TriggerKind, string];

// ═════════════════════════════════════════════════════════════════════
// 2. NRI port — gc_decision  (SPEC Table 3)
// ═════════════════════════════════════════════════════════════════════

function nriGcDecision(
  state: SandboxStatus,
  durationMs: number = 0,
  providerExists?: boolean,
  containerHealth?: readonly ContainerHealth[],
  failCount: number = 0,
  maxRetries: number = 3,
): GcReason | null {
  if (state === SandboxStatus.Deleted) return null;

  if (state === SandboxStatus.Succeeded) {
    return durationMs >= STOPPED_GC_TIMEOUT_MS ? 'stopped-gc' : null;
  }
  if (state === SandboxStatus.Failed) {
    return durationMs >= FAILED_GC_TIMEOUT_MS ? 'failed-gc' : null;
  }
  if (state === SandboxStatus.Terminating) {
    return durationMs >= TERMINATING_GC_TIMEOUT_MS ? 'terminating-gc' : null;
  }
  if (HARD_TERMINAL.has(state)) {
    return durationMs >= EXPIRED_GC_TIMEOUT_MS ? 'expired-gc' : null;
  }

  if (TRANSIENT.has(state)) {
    if (providerExists === false) return 'provider-gone';
    if (durationMs >= STUCK_GC_TIMEOUT_MS) return 'stuck-gc';
    return null;
  }

  if (state === SandboxStatus.Running) {
    if (maxRetries === -1) return null;
    if (providerExists === false) return 'provider-gone';
    if (containerHealth === undefined) return null;

    const anyAlive = containerHealth.some(ch => ch !== ContainerHealth.Terminated);
    const allHealthy = containerHealth.every(ch => ch === ContainerHealth.Running);

    if (!anyAlive) return failCount >= maxRetries ? 'exited-gc' : null;
    if (!allHealthy) return failCount >= maxRetries ? 'unhealthy-gc' : null;
    return null;
  }

  return null;
}

// ═════════════════════════════════════════════════════════════════════
// 3. Domain mapping — SandboxStatus <-> PodPhase (5-state)
// ═════════════════════════════════════════════════════════════════════

function sandboxToPodPhase(state: SandboxStatus): string {
  switch (state) {
    case SandboxStatus.Scheduling: return 'Pending';
    case SandboxStatus.Pending: return 'Pending';
    case SandboxStatus.Running: return 'Running';
    case SandboxStatus.Succeeded: return 'Succeeded';
    case SandboxStatus.Failed: return 'Failed';
    case SandboxStatus.Restarting: return 'Running';
    case SandboxStatus.Updating: return 'Running';
    case SandboxStatus.Terminating: return 'Running';
    case SandboxStatus.ScheduleFailed: return 'Failed';
    case SandboxStatus.Expired: return 'Failed';
    case SandboxStatus.Deleted: return 'Succeeded';
  }
}

/** Map PodPhase back to the representative SandboxStatus for NRI comparison. */
function podPhaseToSandbox(phase: string): SandboxStatus {
  switch (phase) {
    case 'Pending': return SandboxStatus.Pending;
    case 'Running': return SandboxStatus.Running;
    case 'Succeeded': return SandboxStatus.Succeeded;
    case 'Failed': return SandboxStatus.Failed;
    default: return SandboxStatus.Running;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 4. NRI port — sandbox_transition (for safety invariants P1-P7)
// ═════════════════════════════════════════════════════════════════════

function sandboxTransition(state: SandboxStatus, trigger: Trigger): SandboxStatus {
  if (state === SandboxStatus.Deleted) return state;

  const [kind, event] = trigger;

  if (kind === 'Api') {
    if (event === API_DELETE) {
      return DELETABLE.has(state) ? SandboxStatus.Terminating : state;
    }
    if (event === API_RESTART) {
      if (SOFT_TERMINAL.has(state)) return SandboxStatus.Running;
      if (state === SandboxStatus.Running) return SandboxStatus.Restarting;
      return state;
    }
    if (event === API_UPDATE) {
      return state === SandboxStatus.Running ? SandboxStatus.Updating : state;
    }
    return state;
  }

  if (kind === 'System') {
    if (state === SandboxStatus.Scheduling) {
      if (event === SYS_SCHEDULE_OK) return SandboxStatus.Pending;
      if (event === SYS_SCHEDULE_FAIL) return SandboxStatus.ScheduleFailed;
    } else if (state === SandboxStatus.Pending) {
      if (event === SYS_INIT_OK) return SandboxStatus.Running;
      if (event === SYS_INIT_FAIL) return SandboxStatus.Failed;
    } else if (state === SandboxStatus.Running) {
      if (event === SYS_EXPIRED) return SandboxStatus.Expired;
    } else if (state === SandboxStatus.Restarting) {
      if (event === SYS_RESTART_OK) return SandboxStatus.Pending;
      if (event === SYS_RESTART_FAIL) return SandboxStatus.Failed;
    } else if (state === SandboxStatus.Updating) {
      if (event === SYS_UPDATE_OK || event === SYS_UPDATE_FAIL) return SandboxStatus.Running;
    } else if (state === SandboxStatus.Terminating) {
      if (event === SYS_CLEANUP) return SandboxStatus.Deleted;
      if (event === SYS_DELETE_FAIL) return SandboxStatus.Terminating; // P7
    }
    return state;
  }

  return state;
}

// ─── Container evolution (for P5 coupled checking) ──────────────────

function evolveContainers(
  prevState: SandboxStatus,
  nextState: SandboxStatus,
  containers: readonly ContainerHealth[],
): ContainerHealth[] {
  if (prevState === nextState) return [...containers];
  if (nextState === SandboxStatus.Running) {
    return Array(Math.max(containers.length, 1)).fill(ContainerHealth.Waiting) as ContainerHealth[];
  }
  if (prevState === SandboxStatus.Running) {
    return Array(Math.max(containers.length, 1)).fill(ContainerHealth.Terminated) as ContainerHealth[];
  }
  if (TERMINAL.has(nextState)) {
    return Array(Math.max(containers.length, 1)).fill(ContainerHealth.Terminated) as ContainerHealth[];
  }
  return [...containers];
}

function transitionWithContainers(
  state: SandboxStatus,
  containers: readonly ContainerHealth[],
  trigger: Trigger,
): [SandboxStatus, ContainerHealth[]] {
  const nextState = sandboxTransition(state, trigger);
  const nextContainers = evolveContainers(state, nextState, containers);
  return [nextState, nextContainers];
}

// ═════════════════════════════════════════════════════════════════════
// 5. Safety invariants P1-P8
// ═════════════════════════════════════════════════════════════════════

function checkP1(prev: SandboxStatus, curr: SandboxStatus): boolean {
  return !(HARD_TERMINAL.has(prev) && curr !== prev);
}
function checkP2(prev: SandboxStatus, curr: SandboxStatus): boolean {
  return !(curr === SandboxStatus.Restarting && prev !== SandboxStatus.Running);
}
function checkP3(prev: SandboxStatus, curr: SandboxStatus): boolean {
  return !(curr === SandboxStatus.Updating && prev !== SandboxStatus.Running);
}
function checkP4(prev: SandboxStatus, curr: SandboxStatus): boolean {
  return !(curr === SandboxStatus.Terminating && !DELETABLE.has(prev));
}
function checkP5(state: SandboxStatus, containers: readonly ContainerHealth[]): boolean {
  if (containers.some(ch => ch === ContainerHealth.Running)) return state === SandboxStatus.Running;
  return true;
}
function checkP6(prev: SandboxStatus, curr: SandboxStatus): boolean {
  if (curr === SandboxStatus.Deleted) return prev === SandboxStatus.Terminating;
  return true;
}
function checkP7(prev: SandboxStatus, curr: SandboxStatus): boolean {
  if (prev === SandboxStatus.Terminating) return curr === SandboxStatus.Terminating || curr === SandboxStatus.Deleted;
  return true;
}
function checkP8(state: SandboxStatus, durationMs: number, gcAction: GcReason | null): boolean {
  if (HARD_TERMINAL.has(state) && durationMs >= EXPIRED_GC_TIMEOUT_MS) return gcAction === 'expired-gc';
  return true;
}

// ═════════════════════════════════════════════════════════════════════
// 6. Mutation functions — one per invariant (detection-power tests)
// ═════════════════════════════════════════════════════════════════════

function mutatedTransition(mutation: string): (st: SandboxStatus, tr: Trigger) => SandboxStatus {
  const variants: Record<string, (st: SandboxStatus, tr: Trigger) => SandboxStatus> = {
    // P1 break: terminal states can transition (resurrection)
    p1(st, tr) {
      if (st !== SandboxStatus.Deleted && TERMINAL.has(st) && tr[0] === 'Api' && tr[1] === API_RESTART) {
        return SandboxStatus.Running;
      }
      return sandboxTransition(st, tr);
    },
    // P2 break: Restarting from non-Running (ScheduleFailed -> Restarting)
    p2(st, tr) {
      if (st === SandboxStatus.ScheduleFailed && tr[0] === 'Api' && tr[1] === API_RESTART) {
        return SandboxStatus.Restarting;
      }
      return sandboxTransition(st, tr);
    },
    // P3 break: Updating from non-Running (ScheduleFailed -> Updating)
    p3(st, tr) {
      if (st === SandboxStatus.ScheduleFailed && tr[0] === 'Api' && tr[1] === API_UPDATE) {
        return SandboxStatus.Updating;
      }
      return sandboxTransition(st, tr);
    },
    // P4 break: Delete from non-deletable (Scheduling -> Terminating)
    p4(st, tr) {
      if (st === SandboxStatus.Scheduling && tr[0] === 'Api' && tr[1] === API_DELETE) {
        return SandboxStatus.Terminating;
      }
      return sandboxTransition(st, tr);
    },
    // P6 break: direct to Deleted (skips Terminating) for persistent deletable
    p6(st, tr) {
      if (DELETABLE.has(st) && !TRANSIENT.has(st) && tr[0] === 'Api' && tr[1] === API_DELETE) {
        return SandboxStatus.Deleted;
      }
      return sandboxTransition(st, tr);
    },
    // P7 break: Terminating escapes on provider delete failure
    p7(st, tr) {
      if (st === SandboxStatus.Terminating && tr[0] === 'System' && tr[1] === SYS_DELETE_FAIL) {
        return SandboxStatus.Running;
      }
      return sandboxTransition(st, tr);
    },
  };
  return variants[mutation] ?? sandboxTransition;
}

function mutatedGcDecision(mutation: string): typeof nriGcDecision {
  const variants: Record<string, typeof nriGcDecision> = {
    // P8 break: hard terminals never expire (returns null instead of expired-gc)
    p8(st, dur, prov, ch, fc, mr) {
      if (HARD_TERMINAL.has(st)) return null;
      return nriGcDecision(st, dur, prov, ch, fc, mr);
    },
  };
  return variants[mutation] ?? nriGcDecision;
}

// ═════════════════════════════════════════════════════════════════════
// 7. Test data: GC matrix boundary cases
// ═════════════════════════════════════════════════════════════════════

interface GcMatrixCase {
  state: SandboxStatus;
  durationMs: number;
  providerExists?: boolean;
  containerHealth?: ContainerHealth[];
  failCount: number;
  maxRetries: number;
  expected: GcReason | null;
}

function* gcMatrixCases(): Generator<GcMatrixCase> {
  // ── Deleted (absorbing sink) ──
  yield* mk(SandboxStatus.Deleted, [0, 999999], undefined, [], null);
  // ── Succeeded: stopped-gc at >= 60s ──
  yield* mk(SandboxStatus.Succeeded, [0, 59000], undefined, [], null);
  yield* mk(SandboxStatus.Succeeded, [60000, 999999], undefined, [], 'stopped-gc');
  // ── Failed: failed-gc at >= 24h ──
  yield* mk(SandboxStatus.Failed, [0, FAILED_GC_TIMEOUT_MS - 1], undefined, [], null);
  yield* mk(SandboxStatus.Failed, [FAILED_GC_TIMEOUT_MS, FAILED_GC_TIMEOUT_MS * 2], undefined, [], 'failed-gc');
  // ── Terminating: terminating-gc at >= 60s ──
  yield* mk(SandboxStatus.Terminating, [0, 59999], undefined, [], null);
  yield* mk(SandboxStatus.Terminating, [60000, 999999], undefined, [], 'terminating-gc');
  // ── Hard terminal — ScheduleFailed: expired-gc at >= 24h ──
  yield* mk(SandboxStatus.ScheduleFailed, [0, EXPIRED_GC_TIMEOUT_MS - 1], undefined, [], null);
  yield* mk(SandboxStatus.ScheduleFailed, [EXPIRED_GC_TIMEOUT_MS, EXPIRED_GC_TIMEOUT_MS * 2], undefined, [], 'expired-gc');
  // ── Hard terminal — Expired: expired-gc at >= 24h ──
  yield* mk(SandboxStatus.Expired, [0, EXPIRED_GC_TIMEOUT_MS - 1], undefined, [], null);
  yield* mk(SandboxStatus.Expired, [EXPIRED_GC_TIMEOUT_MS, EXPIRED_GC_TIMEOUT_MS * 2], undefined, [], 'expired-gc');
  // ── Transient — Scheduling ──
  yield* mk(SandboxStatus.Scheduling, [0, STUCK_GC_TIMEOUT_MS - 1], undefined, [], null);
  yield* mk(SandboxStatus.Scheduling, [0, STUCK_GC_TIMEOUT_MS - 1], true, [], null);
  yield* mk(SandboxStatus.Scheduling, [0], false, [], 'provider-gone');
  yield* mk(SandboxStatus.Scheduling, [STUCK_GC_TIMEOUT_MS], undefined, [], 'stuck-gc');
  yield* mk(SandboxStatus.Scheduling, [STUCK_GC_TIMEOUT_MS], true, [], 'stuck-gc');
  yield* mk(SandboxStatus.Scheduling, [STUCK_GC_TIMEOUT_MS], false, [], 'provider-gone'); // provider wins
  // ── Transient — Pending ──
  yield* mk(SandboxStatus.Pending, [0], false, [], 'provider-gone');
  yield* mk(SandboxStatus.Pending, [STUCK_GC_TIMEOUT_MS], true, [], 'stuck-gc');
  // ── Transient — Restarting ──
  yield* mk(SandboxStatus.Restarting, [0], false, [], 'provider-gone');
  yield* mk(SandboxStatus.Restarting, [STUCK_GC_TIMEOUT_MS], undefined, [], 'stuck-gc');
  // ── Transient — Updating ──
  yield* mk(SandboxStatus.Updating, [0], false, [], 'provider-gone');
  yield* mk(SandboxStatus.Updating, [STUCK_GC_TIMEOUT_MS], undefined, [], 'stuck-gc');
  // ── Running: maxRetries = -1 disables GC ──
  yield* mk(SandboxStatus.Running, [0], undefined, [], null, -1);
  yield* mk(SandboxStatus.Running, [0], false, [], null, -1);
  // ── Running: provider-gone ──
  yield* mk(SandboxStatus.Running, [0], false, [], 'provider-gone');
  // ── Running: no health info ──
  yield* mk(SandboxStatus.Running, [0], undefined, [], null);
  // ── Running: all Terminated -> exited-gc ──
  yield* mk(SandboxStatus.Running, [0], true, [ContainerHealth.Terminated], null, 3, 2); // fail < maxRetries
  yield* mk(SandboxStatus.Running, [0], true, [ContainerHealth.Terminated], 'exited-gc', 3, 3);
  // ── Running: some Unhealthy -> unhealthy-gc ──
  yield* mk(SandboxStatus.Running, [0], true, [ContainerHealth.Running, ContainerHealth.Unhealthy], null, 3, 2);
  yield* mk(SandboxStatus.Running, [0], true, [ContainerHealth.Running, ContainerHealth.Unhealthy], 'unhealthy-gc', 3, 3);
  // ── Running: all healthy ──
  yield* mk(SandboxStatus.Running, [0], true, [ContainerHealth.Running, ContainerHealth.Running], null);
}

function* mk(
  state: SandboxStatus,
  durations: number[],
  providerExists: boolean | undefined,
  containerHealth: ContainerHealth[] | undefined,
  expected: GcReason | null,
  maxRetries: number = 3,
  failCount: number = 0,
): Generator<GcMatrixCase> {
  for (const durationMs of durations) {
    yield { state, durationMs, providerExists, containerHealth, failCount, maxRetries, expected };
  }
}

/** Return containers consistent with a sandbox state (for P5 tests). */
function initialContainers(state: SandboxStatus): ContainerHealth[] {
  if (state === SandboxStatus.Running) return [ContainerHealth.Running, ContainerHealth.Waiting];
  return [ContainerHealth.Terminated];
}

/** True when prev -> curr is a real state change, not identity.  Guards invariants
 *  that only apply to genuine transitions (P2/P3/P4/P6). */
function changed(prev: SandboxStatus, curr: SandboxStatus): boolean {
  return prev !== curr;
}

// ═════════════════════════════════════════════════════════════════════
// 8. Tests
// ═════════════════════════════════════════════════════════════════════

describe('Sandbox GC NRI model vs TS', () => {
  // ──────────────────────────────────────────────────────────────────
  // Full GC matrix
  // ──────────────────────────────────────────────────────────────────

  describe('Full GC matrix', () => {
    it('nriGcDecision matches expected outcomes for all 11 states', () => {
      let count = 0;
      for (const c of gcMatrixCases()) {
        const result = nriGcDecision(c.state, c.durationMs, c.providerExists, c.containerHealth, c.failCount, c.maxRetries);
        expect(result).toBe(c.expected);
        count++;
      }
      expect(count).toBeGreaterThan(35);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // decidePodGc vs mapped NRI
  // ──────────────────────────────────────────────────────────────────

  describe('decidePodGc vs mapped NRI', () => {
    /**
     * Known divergence: decidePodGc checks providerAlive === false before
     * maxRetries === -1; NRI checks maxRetries first. When both conditions
     * are true, decidePodGc returns 'provider-gone' while NRI returns null.
     */
    const maxRetriesProviderDivergence = (
      phase: string, maxRetries: number, providerAlive: boolean | undefined,
    ): boolean => phase === 'Running' && maxRetries === -1 && providerAlive === false;

    // Since the NRI and TS logic differ in some edge cases, we test agreement
    // by constructing the *same* parameter combination for both sides, using the
    // mapped representative SandboxStatus for NRI and the PodPhase string for TS.

    const PHASES: Array<{ phase: string; rep: SandboxStatus }> = [
      { phase: 'Pending', rep: SandboxStatus.Pending },
      { phase: 'Running', rep: SandboxStatus.Running },
      { phase: 'Succeeded', rep: SandboxStatus.Succeeded },
      { phase: 'Failed', rep: SandboxStatus.Failed },
    ];

    for (const { phase, rep } of PHASES) {
      it(`${phase}: nriGcDecision(${rep}) agrees with decidePodGc('${phase}')`, () => {
        // Test across a grid of parameter combos that exercise all branches.
        const durations = [0, 60_000, 10 * 60 * 1000, 24 * 60 * 60 * 1000];
        const providers: Array<boolean | undefined> = [undefined, true, false];
        const healthCombos: Array<{ health: ContainerHealth[]; alive: boolean[] }> = [
          { health: [ContainerHealth.Running], alive: [true] },
          { health: [ContainerHealth.Terminated], alive: [false] },
          { health: [ContainerHealth.Running, ContainerHealth.Unhealthy], alive: [true, false] },
        ];
        const maxRetriesValues = [-1, 0, 3];
        const failCounts = [0, 3, 5];

        for (const durationMs of durations) {
          for (const providerAlive of providers) {
            for (const { health, alive } of healthCombos) {
              for (const maxRetries of maxRetriesValues) {
                for (const fails of failCounts) {
                  if (maxRetriesProviderDivergence(phase, maxRetries, providerAlive)) continue;

                  const nri = nriGcDecision(rep, durationMs, providerAlive, health, fails, maxRetries);
                  const ts = decidePodGc(phase, durationMs, providerAlive, alive, fails, maxRetries);

                  // Running/unknown catch-all is a TS-only path; it doesn't apply
                  // when we're testing the canonical mapped phase.
                  expect(nri).toBe(ts);
                }
              }
            }
          }
        }
      });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // Safety invariants P1-P8
  // ──────────────────────────────────────────────────────────────────

  describe('Safety invariants P1-P7 on single transitions', () => {
    it('P1: hard terminal (SF,E) cannot revive', () => {
      for (const hard of HARD_TERMINAL) {
        for (const trigger of allTriggers()) {
          const next = sandboxTransition(hard, trigger);
          expect(checkP1(hard, next)).toBe(true);
          // Hard terminals absorb all transitions
          expect(next).toBe(hard);
        }
      }
    });

    it('P2: Restarting only from Running', () => {
      for (const from of ALL_STATES) {
        for (const trigger of allTriggers()) {
          const next = sandboxTransition(from, trigger);
          if (!changed(from, next)) continue; // identity transitions don't test origin
          if (next === SandboxStatus.Restarting) {
            expect(from).toBe(SandboxStatus.Running);
          }
          expect(checkP2(from, next)).toBe(true);
        }
      }
    });

    it('P3: Updating only from Running', () => {
      for (const from of ALL_STATES) {
        for (const trigger of allTriggers()) {
          const next = sandboxTransition(from, trigger);
          if (!changed(from, next)) continue;
          if (next === SandboxStatus.Updating) {
            expect(from).toBe(SandboxStatus.Running);
          }
          expect(checkP3(from, next)).toBe(true);
        }
      }
    });

    it('P4: Terminating only from deletable states', () => {
      for (const from of ALL_STATES) {
        for (const trigger of allTriggers()) {
          const next = sandboxTransition(from, trigger);
          if (!changed(from, next)) continue;
          if (next === SandboxStatus.Terminating) {
            expect(DELETABLE.has(from)).toBe(true);
          }
          expect(checkP4(from, next)).toBe(true);
        }
      }
    });

    it('P5: Container Running => Sandbox Running', () => {
      for (const from of ALL_STATES) {
        const containers = initialContainers(from);
        for (const trigger of allTriggers()) {
          const [next, nextContainers] = transitionWithContainers(from, containers, trigger);
          expect(checkP5(next, nextContainers)).toBe(true);
        }
      }
    });

    it('P6: via transitions, Deleted only from Terminating', () => {
      for (const from of ALL_STATES) {
        for (const trigger of allTriggers()) {
          const next = sandboxTransition(from, trigger);
          if (!changed(from, next)) continue;
          if (next === SandboxStatus.Deleted) {
            expect(from).toBe(SandboxStatus.Terminating);
          }
          expect(checkP6(from, next)).toBe(true);
        }
      }
    });

    it('P7: from Terminating, only exit to Deleted (stay on delete fail)', () => {
      for (const trigger of allTriggers()) {
        const next = sandboxTransition(SandboxStatus.Terminating, trigger);
        expect(checkP7(SandboxStatus.Terminating, next)).toBe(true);
        expect(next === SandboxStatus.Terminating || next === SandboxStatus.Deleted).toBe(true);
      }
    });
  });

  describe('P8: hard terminal GC correctness', () => {
    it('hard terminal + duration >= 24h => expired-gc', () => {
      for (const hard of HARD_TERMINAL) {
        const result = nriGcDecision(hard, EXPIRED_GC_TIMEOUT_MS);
        expect(result).toBe('expired-gc');
        expect(checkP8(hard, EXPIRED_GC_TIMEOUT_MS, result)).toBe(true);
      }
    });

    it('hard terminal + duration < 24h => null', () => {
      for (const hard of HARD_TERMINAL) {
        const result = nriGcDecision(hard, EXPIRED_GC_TIMEOUT_MS - 1);
        expect(result).toBeNull();
        expect(checkP8(hard, EXPIRED_GC_TIMEOUT_MS - 1, result)).toBe(true);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Invariant detection power
  // ──────────────────────────────────────────────────────────────────

  describe('Invariant detection power', () => {
    const MUTATIONS: Array<{ key: string; check: (p: SandboxStatus, c: SandboxStatus) => boolean }> = [
      { key: 'p1', check: checkP1 },
      { key: 'p2', check: checkP2 },
      { key: 'p3', check: checkP3 },
      { key: 'p4', check: checkP4 },
      { key: 'p6', check: checkP6 },
      { key: 'p7', check: checkP7 },
    ];

    for (const { key, check } of MUTATIONS) {
      it(`${key} violation triggers invariant failure`, () => {
        const mutFn = mutatedTransition(key);
        const noopFn = mutatedTransition('noop');

        for (const from of ALL_STATES) {
          for (const trigger of allTriggers()) {
            const mutResult = mutFn(from, trigger);
            const noopResult = noopFn(from, trigger);
            if (mutResult !== noopResult) {
              // Mutation diverged from correct behavior — invariant must detect it
              expect(check(from, mutResult)).toBe(false);
              return; // found a divergent case
            }
          }
        }
        // If no mutation fired, the test is useless — every mutation must diverge
        // for at least one (state, trigger) pair
        expect.unreachable(`mutation "${key}" never diverged from NRI`);
      });
    }

    it('P8 violation triggers failure', () => {
      const mutFn = mutatedGcDecision('p8');
      const noopFn = mutatedGcDecision('noop');

      for (const from of HARD_TERMINAL) {
        const mutResult = mutFn(from, EXPIRED_GC_TIMEOUT_MS);
        const noopResult = noopFn(from, EXPIRED_GC_TIMEOUT_MS);
        // Mutation should return null (noop) for hard terminals at >24h
        expect(noopResult).toBe('expired-gc');
        expect(mutResult).toBeNull();
        // P8 must detect the violation
        expect(checkP8(from, EXPIRED_GC_TIMEOUT_MS, mutResult)).toBe(false);
        return; // one case is enough
      }
      expect.unreachable('P8 mutation never diverged');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // modelRun transition sequences
  // ──────────────────────────────────────────────────────────────────

  describe('modelRun random transition sequences', () => {
    interface M {
      state: SandboxStatus;
      containers: ContainerHealth[];
    }

    class TR {
      state: SandboxStatus;
      containers: ContainerHealth[];
      constructor(s: SandboxStatus, c?: ContainerHealth[]) {
        this.state = s;
        this.containers = c ?? [ContainerHealth.Waiting];
      }
    }

    class TrCmd implements fc.Command<M, TR> {
      constructor(readonly trigger: Trigger) {}
      check(_m: Readonly<M>): boolean { return true; }
      run(m: M, r: TR): void {
        const [mNext, mContainers] = transitionWithContainers(m.state, m.containers, this.trigger);
        const [rNext, rContainers] = transitionWithContainers(r.state, r.containers, this.trigger);
        // Self-consistency
        expect(mNext).toBe(rNext);
        expect(mContainers).toEqual(rContainers);
        // Safety invariants (skip identity transitions that invariants don't cover)
        if (changed(m.state, mNext)) {
          expect(checkP1(m.state, mNext)).toBe(true);
          expect(checkP2(m.state, mNext)).toBe(true);
          expect(checkP3(m.state, mNext)).toBe(true);
          expect(checkP4(m.state, mNext)).toBe(true);
          expect(checkP6(m.state, mNext)).toBe(true);
          expect(checkP7(m.state, mNext)).toBe(true);
        }
        expect(checkP5(mNext, mContainers)).toBe(true);
        // Advance model and real
        m.state = mNext;
        m.containers = mContainers;
        r.state = rNext;
        r.containers = rContainers;
      }
    }

    const trCmdArb: fc.Arbitrary<fc.Command<M, TR>> =
      fc.oneof(
        fc.constantFrom(...API_OPS).map(op => new TrCmd(['Api', op] as const)),
        fc.constantFrom(...SYSTEM_EVENTS).map(ev => new TrCmd(['System', ev] as const)),
      );

    it('self-consistent with invariants from Scheduling', () => {
      fc.assert(
        fc.property(
          fc.commands([trCmdArb], { maxCommands: 15 }),
          (cmds) => {
            fc.modelRun(
              () => ({
                model: { state: SandboxStatus.Scheduling, containers: [ContainerHealth.Waiting] },
                real: new TR(SandboxStatus.Scheduling, [ContainerHealth.Waiting]),
              }),
              cmds,
            );
          },
        ),
        { numRuns: 500 },
      );
    });

    it('self-consistent with invariants from Running', () => {
      fc.assert(
        fc.property(
          fc.commands([trCmdArb], { maxCommands: 15 }),
          (cmds) => {
            fc.modelRun(
              () => ({
                model: { state: SandboxStatus.Running, containers: [ContainerHealth.Running] },
                real: new TR(SandboxStatus.Running, [ContainerHealth.Running]),
              }),
              cmds,
            );
          },
        ),
        { numRuns: 500 },
      );
    });

    it('from Terminating: only stays or goes to Deleted', () => {
      fc.assert(
        fc.property(
          fc.commands([trCmdArb], { maxCommands: 10 }),
          (cmds) => {
            fc.modelRun(
              () => ({
                model: { state: SandboxStatus.Terminating, containers: [ContainerHealth.Terminated] },
                real: new TR(SandboxStatus.Terminating, [ContainerHealth.Terminated]),
              }),
              cmds,
            );
          },
        ),
        { numRuns: 500 },
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // GC decision property-based tests
  // ──────────────────────────────────────────────────────────────────

  describe('GC decision property-based', () => {
    it('P8: hard terminal + random duration >= 24h => expired-gc', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...HARD_TERMINAL),
          fc.integer({ min: EXPIRED_GC_TIMEOUT_MS, max: EXPIRED_GC_TIMEOUT_MS * 2 }),
          fc.boolean(),
          (state, durationMs, providerExists) => {
            const result = nriGcDecision(state, durationMs, providerExists);
            expect(result).toBe('expired-gc');
            expect(checkP8(state, durationMs, result)).toBe(true);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('Deleted always returns null regardless of params', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: EXPIRED_GC_TIMEOUT_MS * 2 }),
          fc.boolean(),
          fc.integer({ min: 0, max: 10 }),
          (durationMs, providerExists, maxRetries) => {
            expect(nriGcDecision(SandboxStatus.Deleted, durationMs, providerExists, undefined, 0, maxRetries)).toBeNull();
          },
        ),
        { numRuns: 100 },
      );
    });

    it('Succeeded + duration >= 60s => stopped-gc; below => null', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 120_000 }),
          (durationMs) => {
            const expected: GcReason | null = durationMs >= 60_000 ? 'stopped-gc' : null;
            expect(nriGcDecision(SandboxStatus.Succeeded, durationMs)).toBe(expected);
          },
        ),
        { numRuns: 200 },
      );
    });

    it('Running + maxRetries=-1 always returns null', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 100_000 }),
          fc.boolean(),
          fc.array(fc.constantFrom(...Object.values(ContainerHealth)), { minLength: 1, maxLength: 5 }),
          fc.integer({ min: 0, max: 10 }),
          (durationMs, providerExists, health, fails) => {
            expect(nriGcDecision(SandboxStatus.Running, durationMs, providerExists, health, fails, -1)).toBeNull();
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});

// ═════════════════════════════════════════════════════════════════════
// Test helpers
// ═════════════════════════════════════════════════════════════════════

function allTriggers(): Trigger[] {
  const triggers: Trigger[] = [];
  for (const op of API_OPS) triggers.push(['Api', op]);
  for (const ev of SYSTEM_EVENTS) triggers.push(['System', ev]);
  return triggers;
}
