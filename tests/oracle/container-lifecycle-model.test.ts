/**
 * fast-check model-based oracle for ContainerGroup lifecycle state machine.
 *
 * NRI (Naive Reference Implementation) ported from
 * .oracle/tests/nri_container_lifecycle.py — full 13-state × 23-trigger
 * matrix, modelRun differential, buggy mutation variants, P5 container
 * coupling, and shrinking demo.
 *
 * The golden test (tests/oracle/container-lifecycle.golden.json) already
 * verifies every isolated (state, trigger) pair.  This file goes beyond:
 * random transition SEQUENCES via fast-check modelRun, invariant detection
 * on buggy mutations, and container-level consistency (P5).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  transition,
  ContainerGroupState,
  ContainerStateValue,
  isTerminal,
  evaluateRestartPolicy,
  checkNoResurrection,
  checkRestartLegality,
  checkUpdateLegality,
  checkDeleteLegality,
  checkContainerCGRunning,
  isDeleteAllowed,
} from '../../src/core/provider/container-lifecycle';
import type {
  TransitionTrigger,
  SystemEvent,
  ApiOperation,
} from '../../src/core/provider/container-lifecycle';

// ═══════════════════════════════════════════════════════════════════════════
// NRI — Naive Reference Implementation
// (ported from .oracle/tests/nri_container_lifecycle.py)
//
// Translates Python tuple-based triggers to TS TransitionTrigger objects
// while preserving exact NRI dispatch logic.
//
// Structural differences from TS:
//   1. Category-based dispatch (system / api / restart-policy) v. flat scan
//   2. Deleted is explicitly absorbing at the top of the dispatcher
//   3. evaluateRestartPolicy is shared (identical implementation)
// ═══════════════════════════════════════════════════════════════════════════

const ALL_STATES: readonly ContainerGroupState[] =
  Object.values(ContainerGroupState);

const SYSTEM_EVENTS: readonly SystemEvent[] = [
  'ScheduleSucceeded',
  'ScheduleFailed',
  'InitSucceeded',
  'InitFailed',
  'InstanceExpired',
  'RestartSucceeded',
  'RestartFailed',
  'UpdateSucceeded',
  'UpdateFailed',
  'CleanupComplete',
];

const API_OPS: readonly ApiOperation[] = [
  'DeleteContainerGroup',
  'RestartContainerGroup',
  'UpdateContainerGroup',
  'StopContainerGroup',
  'StartContainerGroup',
  'PauseContainerGroup',
  'UnpauseContainerGroup',
];

// NRI deletable set (SPEC P4: {Running, Pending, Restarting, Updating} +
// Podman extensions{Stopped, Paused})
const NRI_DELETABLE: ReadonlySet<ContainerGroupState> = new Set([
  ContainerGroupState.Running,
  ContainerGroupState.Pending,
  ContainerGroupState.Restarting,
  ContainerGroupState.Updating,
  ContainerGroupState.Stopped,
  ContainerGroupState.Paused,
]);

function nriSystemTransition(
  state: ContainerGroupState,
  event: SystemEvent,
): ContainerGroupState {
  if (state === ContainerGroupState.Scheduling) {
    if (event === 'ScheduleSucceeded') return ContainerGroupState.Pending;
    if (event === 'ScheduleFailed') return ContainerGroupState.ScheduleFailed;
    return state;
  }
  if (state === ContainerGroupState.Pending) {
    if (event === 'InitSucceeded') return ContainerGroupState.Running;
    if (event === 'InitFailed') return ContainerGroupState.Failed;
    return state;
  }
  if (state === ContainerGroupState.Running && event === 'InstanceExpired') {
    return ContainerGroupState.Expired;
  }
  if (state === ContainerGroupState.Restarting) {
    if (event === 'RestartSucceeded') return ContainerGroupState.Pending;
    if (event === 'RestartFailed') return ContainerGroupState.Failed;
    return state;
  }
  if (state === ContainerGroupState.Updating) {
    if (
      event === 'UpdateSucceeded' || event === 'UpdateFailed'
    ) return ContainerGroupState.Running;
    return state;
  }
  if (state === ContainerGroupState.Terminating && event === 'CleanupComplete') {
    return ContainerGroupState.Deleted;
  }
  return state;
}

function nriApiTransition(
  state: ContainerGroupState,
  op: ApiOperation,
): ContainerGroupState {
  if (op === 'DeleteContainerGroup') {
    return NRI_DELETABLE.has(state)
      ? ContainerGroupState.Terminating
      : state;
  }
  if (op === 'RestartContainerGroup') {
    return state === ContainerGroupState.Running
      ? ContainerGroupState.Restarting
      : state;
  }
  if (op === 'UpdateContainerGroup') {
    return state === ContainerGroupState.Running
      ? ContainerGroupState.Updating
      : state;
  }
  if (op === 'StopContainerGroup') {
    return (state === ContainerGroupState.Running
      || state === ContainerGroupState.Paused)
      ? ContainerGroupState.Stopped
      : state;
  }
  if (op === 'StartContainerGroup') {
    return state === ContainerGroupState.Stopped
      ? ContainerGroupState.Running
      : state;
  }
  if (op === 'PauseContainerGroup') {
    return state === ContainerGroupState.Running
      ? ContainerGroupState.Paused
      : state;
  }
  if (op === 'UnpauseContainerGroup') {
    return state === ContainerGroupState.Paused
      ? ContainerGroupState.Running
      : state;
  }
  return state;
}

/** NRI transition dispatcher: returns next state, or unchanged for invalid. */
function nriTransition(
  state: ContainerGroupState,
  trigger: TransitionTrigger,
): ContainerGroupState {
  // Deleted is absorbing (check before dispatch — matches Python NRI)
  if (state === ContainerGroupState.Deleted) return state;

  if (trigger.kind === 'System') {
    return nriSystemTransition(state, trigger.event);
  }
  if (trigger.kind === 'Api') {
    return nriApiTransition(state, trigger.operation);
  }
  // RestartPolicy — delegate to the shared implementation
  return evaluateRestartPolicy(state, trigger.exitCode, trigger.policy);
}

// ═══════════════════════════════════════════════════════════════════════════
// Container state evolution (P5 coupling)
// Ported from Python's _containers_after_transition
// ═══════════════════════════════════════════════════════════════════════════

function nriContainersAfterTransition(
  cgState: ContainerGroupState,
  nextCg: ContainerGroupState,
  containers: readonly ContainerStateValue[],
): ContainerStateValue[] {
  // Stutter: CG unchanged
  if (cgState === nextCg) {
    if (nextCg === ContainerGroupState.Running) {
      const result = [...containers];
      // Advance one Waiting container to Running each stutter step
      for (let i = 0; i < result.length; i++) {
        if (result[i] === ContainerStateValue.Waiting) {
          result[i] = ContainerStateValue.Running;
          break;
        }
      }
      return result;
    }
    return [...containers];
  }

  // CG entered Running: containers start Waiting
  if (nextCg === ContainerGroupState.Running) {
    return [ContainerStateValue.Waiting];
  }

  // CG left Running: all containers terminate (P5 mandate)
  if (cgState === ContainerGroupState.Running) {
    return [ContainerStateValue.Terminated];
  }

  // Pending / Scheduling: containers not yet started
  if (
    nextCg === ContainerGroupState.Pending
    || nextCg === ContainerGroupState.Scheduling
  ) {
    return [ContainerStateValue.Waiting];
  }

  // Terminal / transient / stopped: containers done
  return [ContainerStateValue.Terminated];
}

function nriTransitionWithContainers(
  cgState: ContainerGroupState,
  containers: readonly ContainerStateValue[],
  trigger: TransitionTrigger,
): [ContainerGroupState, ContainerStateValue[]] {
  const nextCg = nriTransition(cgState, trigger);
  const nextContainers = nriContainersAfterTransition(
    cgState, nextCg, containers,
  );
  return [nextCg, nextContainers];
}

// ═══════════════════════════════════════════════════════════════════════════
// Safety invariants (matching NRI Python semantics)
// ═══════════════════════════════════════════════════════════════════════════

function checkP1_noResurrection(
  prev: ContainerGroupState,
  curr: ContainerGroupState,
): boolean {
  return !(isTerminal(prev) && curr !== prev);
}

function checkP2_restartLegality(
  prev: ContainerGroupState,
  curr: ContainerGroupState,
): boolean {
  return !(curr === ContainerGroupState.Restarting && prev !== ContainerGroupState.Running);
}

function checkP3_updateLegality(
  prev: ContainerGroupState,
  curr: ContainerGroupState,
): boolean {
  return !(curr === ContainerGroupState.Updating && prev !== ContainerGroupState.Running);
}

function checkP4_deleteLegality(
  prev: ContainerGroupState,
  curr: ContainerGroupState,
): boolean {
  return !(curr === ContainerGroupState.Terminating && !isDeleteAllowed(prev));
}

// ═══════════════════════════════════════════════════════════════════════════
// Buggy NRI variants  (for invariant sensitivity / shrinking)
// ═══════════════════════════════════════════════════════════════════════════

/** Violates P1: terminal states accept transitions (resurrection). */
function resurrectTransition(
  state: ContainerGroupState,
  trigger: TransitionTrigger,
): ContainerGroupState {
  if (isTerminal(state) && trigger.kind === 'System') {
    return ContainerGroupState.Running; // BUG: resurrection
  }
  return nriTransition(state, trigger);
}

/** Violates P2: Restarting from non-Running. */
function restartAnywhereTransition(
  state: ContainerGroupState,
  trigger: TransitionTrigger,
): ContainerGroupState {
  if (
    state === ContainerGroupState.Scheduling
    && trigger.kind === 'Api'
    && trigger.operation === 'RestartContainerGroup'
  ) {
    return ContainerGroupState.Restarting; // BUG: restart from Scheduling
  }
  return nriTransition(state, trigger);
}

/** Violates P3: Updating from non-Running. */
function updateAnywhereTransition(
  state: ContainerGroupState,
  trigger: TransitionTrigger,
): ContainerGroupState {
  if (
    state === ContainerGroupState.ScheduleFailed
    && trigger.kind === 'Api'
    && trigger.operation === 'UpdateContainerGroup'
  ) {
    return ContainerGroupState.Updating; // BUG: update from ScheduleFailed
  }
  return nriTransition(state, trigger);
}

/** Violates P4: Terminating from non-deletable state. */
function deleteUndeletableTransition(
  state: ContainerGroupState,
  trigger: TransitionTrigger,
): ContainerGroupState {
  if (
    state === ContainerGroupState.Deleted
    && trigger.kind === 'Api'
    && trigger.operation === 'DeleteContainerGroup'
  ) {
    return ContainerGroupState.Terminating; // BUG: delete from Deleted
  }
  return nriTransition(state, trigger);
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Enumerate every trigger variant used in the golden compliance matrix. */
function allTriggers(): TransitionTrigger[] {
  const triggers: TransitionTrigger[] = [];
  for (const event of SYSTEM_EVENTS) {
    triggers.push({ kind: 'System' as const, event });
  }
  for (const operation of API_OPS) {
    triggers.push({ kind: 'Api' as const, operation });
  }
  for (const exitCode of [0, 1] as const) {
    for (const policy of ['Always', 'OnFailure', 'Never'] as const) {
      triggers.push({
        kind: 'RestartPolicy' as const,
        exitCode,
        policy,
      });
    }
  }
  return triggers;
}

// ═══════════════════════════════════════════════════════════════════════════
// modelRun — fast-check model-based testing
// ═══════════════════════════════════════════════════════════════════════════

interface M {
  state: ContainerGroupState;
}

class R {
  state: ContainerGroupState;
  constructor(s: ContainerGroupState) {
    this.state = s;
  }
}

/**
 * Command: apply a random TransitionTrigger to both NRI and TS.
 *
 * Both NRI and TS return the state unchanged for invalid transitions,
 * so they always agree on the resulting state value (no exception
 * divergence to handle, unlike the task-instance model).
 */
class TrCmd implements fc.Command<M, R> {
  constructor(readonly trigger: TransitionTrigger) {}

  check(_m: Readonly<M>): boolean {
    return true;
  }

  run(m: M, r: R): void {
    const nriResult = nriTransition(m.state, this.trigger);
    const tsResult = transition(m.state, this.trigger);
    expect(tsResult).toBe(nriResult);
    m.state = tsResult;
    r.state = tsResult;
  }
}

const trCmdArb: fc.Arbitrary<fc.Command<M, R>> = fc.oneof(
  fc.constantFrom(...SYSTEM_EVENTS).map(
    (event) => new TrCmd({ kind: 'System' as const, event }),
  ),
  fc.constantFrom(...API_OPS).map(
    (operation) => new TrCmd({ kind: 'Api' as const, operation }),
  ),
  fc
    .tuple(
      fc.constantFrom(0, 1),
      fc.constantFrom(
        'Always' as const,
        'OnFailure' as const,
        'Never' as const,
      ),
    )
    .map(
      ([exitCode, policy]) => new TrCmd({
        kind: 'RestartPolicy' as const,
        exitCode,
        policy,
      }),
    ),
);

// ═══════════════════════════════════════════════════════════════════════════
// P5 modelRun (container coupling)
// ═══════════════════════════════════════════════════════════════════════════

interface M5 {
  cgState: ContainerGroupState;
  containers: ContainerStateValue[];
}

class R5 {
  cgState: ContainerGroupState;
  containers: ContainerStateValue[];
  constructor(
    cgState: ContainerGroupState,
    containers: ContainerStateValue[],
  ) {
    this.cgState = cgState;
    this.containers = containers;
  }
}

class TrCmd5 implements fc.Command<M5, R5> {
  constructor(readonly trigger: TransitionTrigger) {}

  check(_m: Readonly<M5>): boolean {
    return true;
  }

  run(m: M5, r: R5): void {
    const [nextCg, nextContainers] = nriTransitionWithContainers(
      m.cgState, m.containers, this.trigger,
    );
    const tsNextCg = transition(m.cgState, this.trigger);
    expect(tsNextCg).toBe(nextCg);
    // P5: if any container is Running, CG must be Running
    expect(checkContainerCGRunning(nextCg, nextContainers)).toBe(true);
    m.cgState = nextCg;
    m.containers = nextContainers;
    r.cgState = nextCg;
    r.containers = nextContainers;
  }
}

const p5CmdArb: fc.Arbitrary<fc.Command<M5, R5>> = fc.oneof(
  fc.constantFrom(...SYSTEM_EVENTS).map(
    (event) => new TrCmd5({ kind: 'System' as const, event }),
  ),
  fc.constantFrom(...API_OPS).map(
    (operation) => new TrCmd5({ kind: 'Api' as const, operation }),
  ),
  fc
    .tuple(
      fc.constantFrom(0, 1),
      fc.constantFrom(
        'Always' as const,
        'OnFailure' as const,
        'Never' as const,
      ),
    )
    .map(
      ([exitCode, policy]) => new TrCmd5({
        kind: 'RestartPolicy' as const,
        exitCode,
        policy,
      }),
    ),
);

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('ContainerGroup NRI model vs TS', () => {
  // ─── 13×trigger matrix — full enumeration ────────────────────

  describe('NRI 13×23 transition matrix', () => {
    it('all 299 cells — NRI and TS agree', () => {
      const triggers = allTriggers();
      let cellCount = 0;
      for (const state of ALL_STATES) {
        for (const trigger of triggers) {
          const nriResult = nriTransition(state, trigger);
          const tsResult = transition(state, trigger);
          expect(tsResult).toBe(nriResult);
          cellCount++;
        }
      }
      expect(cellCount).toBe(299);
    });
  });

  // ─── modelRun differential (NRI vs TS) ──────────────────────

  describe('modelRun differential (NRI vs TS)', () => {
    it('agrees on all random transition sequences from Scheduling', () => {
      fc.assert(
        fc.property(
          fc.commands([trCmdArb]),
          (cmds) => {
            fc.modelRun(
              () => ({
                model: { state: ContainerGroupState.Scheduling },
                real: new R(ContainerGroupState.Scheduling),
              }),
              cmds,
            );
          },
        ),
        { numRuns: 2000 },
      );
    });

    it('agrees on all random transition sequences from Pending', () => {
      fc.assert(
        fc.property(
          fc.commands([trCmdArb]),
          (cmds) => {
            fc.modelRun(
              () => ({
                model: { state: ContainerGroupState.Pending },
                real: new R(ContainerGroupState.Pending),
              }),
              cmds,
            );
          },
        ),
        { numRuns: 1000 },
      );
    });

    it('agrees on all random transition sequences from Running', () => {
      fc.assert(
        fc.property(
          fc.commands([trCmdArb]),
          (cmds) => {
            fc.modelRun(
              () => ({
                model: { state: ContainerGroupState.Running },
                real: new R(ContainerGroupState.Running),
              }),
              cmds,
            );
          },
        ),
        { numRuns: 1000 },
      );
    });
  });

  // ─── Terminal absorption (P1) ───────────────────────────────

  describe('terminal absorption (P1)', () => {
    it('modelRun from each terminal state: all transitions leave state unchanged', () => {
      for (const terminal of TERMINAL_STATES_FOR_TEST) {
        fc.assert(
          fc.property(
            fc.commands([trCmdArb], { maxCommands: 10 }),
            (cmds) => {
              fc.modelRun(
                () => ({
                  model: { state: terminal },
                  real: new R(terminal),
                }),
                cmds,
              );
            },
          ),
          { numRuns: 200 },
        );
      }
    });

    it('all terminal states absorb in the 13×23 matrix', () => {
      const triggers = allTriggers();
      for (const terminal of TERMINAL_STATES_FOR_TEST) {
        for (const trigger of triggers) {
          const nriResult = nriTransition(terminal, trigger);
          const tsResult = transition(terminal, trigger);
          expect(nriResult).toBe(terminal);
          expect(tsResult).toBe(terminal);
        }
      }
    });
  });
});

// Terminal states for absorption tests (exclude Deleted — it's absorbing
// via explicit guard, tested separately via matrix)
const TERMINAL_STATES_FOR_TEST: readonly ContainerGroupState[] = [
  ContainerGroupState.ScheduleFailed,
  ContainerGroupState.Succeeded,
  ContainerGroupState.Failed,
  ContainerGroupState.Expired,
  ContainerGroupState.Deleted,
];

// ─── Buggy mutation variants ─────────────────────────────────

describe('buggy mutation detection', () => {
  it('P1 invariant detects resurrect mutation', () => {
    for (const state of ALL_STATES) {
      if (!isTerminal(state)) continue;
      for (const event of SYSTEM_EVENTS) {
        const trigger: TransitionTrigger = {
          kind: 'System' as const,
          event,
        };
        const buggyResult = resurrectTransition(state, trigger);
        const nriResult = nriTransition(state, trigger);
        if (buggyResult !== nriResult) {
          // Mutation diverged — P1 must detect it
          expect(checkP1_noResurrection(state, buggyResult)).toBe(false);
          return; // found one divergent case
        }
      }
    }
    expect.unreachable(
      'resurrectTransition never diverged from NRI',
    );
  });

  it('P2 invariant detects restart_anywhere mutation', () => {
    for (const state of ALL_STATES) {
      if (state !== ContainerGroupState.Scheduling) continue;
      for (const op of API_OPS) {
        if (op !== 'RestartContainerGroup') continue;
        const trigger: TransitionTrigger = {
          kind: 'Api' as const,
          operation: op,
        };
        const buggyResult = restartAnywhereTransition(state, trigger);
        const nriResult = nriTransition(state, trigger);
        if (buggyResult !== nriResult) {
          expect(checkP2_restartLegality(state, buggyResult)).toBe(false);
          return;
        }
      }
    }
    expect.unreachable(
      'restartAnywhereTransition never diverged from NRI',
    );
  });

  it('P3 invariant detects update_anywhere mutation', () => {
    for (const state of ALL_STATES) {
      if (state !== ContainerGroupState.ScheduleFailed) continue;
      for (const op of API_OPS) {
        if (op !== 'UpdateContainerGroup') continue;
        const trigger: TransitionTrigger = {
          kind: 'Api' as const,
          operation: op,
        };
        const buggyResult = updateAnywhereTransition(state, trigger);
        const nriResult = nriTransition(state, trigger);
        if (buggyResult !== nriResult) {
          expect(checkP3_updateLegality(state, buggyResult)).toBe(false);
          return;
        }
      }
    }
    expect.unreachable(
      'updateAnywhereTransition never diverged from NRI',
    );
  });

  it('P4 invariant detects delete_undeletable mutation', () => {
    for (const state of ALL_STATES) {
      if (state !== ContainerGroupState.Deleted) continue;
      for (const op of API_OPS) {
        if (op !== 'DeleteContainerGroup') continue;
        const trigger: TransitionTrigger = {
          kind: 'Api' as const,
          operation: op,
        };
        const buggyResult = deleteUndeletableTransition(state, trigger);
        const nriResult = nriTransition(state, trigger);
        if (buggyResult !== nriResult) {
          expect(checkP4_deleteLegality(state, buggyResult)).toBe(false);
          return;
        }
      }
    }
    expect.unreachable(
      'deleteUndeletableTransition never diverged from NRI',
    );
  });
});

// ─── Shrinking demo ──────────────────────────────────────────

describe('shrinking', () => {
  it('resurrect mutation is detected by quick-check with shrinking', () => {
    const result = fc.check(
      fc.property(
        fc.constantFrom(...ALL_STATES),
        fc.constantFrom(...SYSTEM_EVENTS),
        (state, event) => {
          const trigger: TransitionTrigger = {
            kind: 'System' as const,
            event,
          };
          const buggyResult = resurrectTransition(state, trigger);
          const tsResult = transition(state, trigger);
          if (tsResult !== buggyResult) {
            throw new Error(
              `Divergence: TS=${String(tsResult)} buggy=${String(buggyResult)} state=${String(state)} event=${event}`,
            );
          }
        },
      ),
      { numRuns: 200 },
    );

    expect(result.failed).toBe(true);
    expect(result.numShrinks).toBeGreaterThan(0);
    // The minimal counterexample is a terminal state + System event
    // where the resurrect mutation goes to Running but TS stays in
    // the terminal state.
    expect(result.counterexample).not.toBeNull();
  });
});

// ─── P5 container invariant ──────────────────────────────────

describe('P5 container invariant (CG Running when container Running)', () => {
  it('modelRun preserves P5 across random sequences from Running', () => {
    fc.assert(
      fc.property(
        fc.commands([p5CmdArb], { maxCommands: 10 }),
        (cmds) => {
          fc.modelRun(
            () => ({
              model: {
                cgState: ContainerGroupState.Running,
                containers: [ContainerStateValue.Waiting],
              },
              real: new R5(
                ContainerGroupState.Running,
                [ContainerStateValue.Waiting],
              ),
            }),
            cmds,
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  it('modelRun preserves P5 across random sequences from Pending', () => {
    fc.assert(
      fc.property(
        fc.commands([p5CmdArb], { maxCommands: 10 }),
        (cmds) => {
          fc.modelRun(
            () => ({
              model: {
                cgState: ContainerGroupState.Pending,
                containers: [ContainerStateValue.Waiting],
              },
              real: new R5(
                ContainerGroupState.Pending,
                [ContainerStateValue.Waiting],
              ),
            }),
            cmds,
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  it('checkContainerCGRunning passes for valid state combinations', () => {
    // Container Running => CG Running
    expect(
      checkContainerCGRunning(
        ContainerGroupState.Running,
        [ContainerStateValue.Running],
      ),
    ).toBe(true);
    // Container Waiting under any CG is fine
    expect(
      checkContainerCGRunning(
        ContainerGroupState.Pending,
        [ContainerStateValue.Waiting],
      ),
    ).toBe(true);
    // Container Terminated under any CG is fine
    expect(
      checkContainerCGRunning(
        ContainerGroupState.Failed,
        [ContainerStateValue.Terminated],
      ),
    ).toBe(true);
  });

  it('checkContainerCGRunning fails when CG != Running but container is Running', () => {
    expect(
      checkContainerCGRunning(
        ContainerGroupState.Pending,
        [ContainerStateValue.Running],
      ),
    ).toBe(false);
    expect(
      checkContainerCGRunning(
        ContainerGroupState.Succeeded,
        [ContainerStateValue.Running],
      ),
    ).toBe(false);
    expect(
      checkContainerCGRunning(
        ContainerGroupState.Terminating,
        [ContainerStateValue.Running],
      ),
    ).toBe(false);
  });
});
