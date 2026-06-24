/**
 * Formal verification tests for the Container Group Lifecycle abstraction.
 * Verifies the model against SPEC/ECI_LIFECYCLE_FORMAL_MODEL.md.
 *
 * Test categories:
 *   1. Transition table correctness (18 ECI + 7 Podman rules)
 *   2. Transition function δ: S × Trigger → S
 *   3. Safety invariants P1–P5
 *   4. API operation preconditions (§4)
 *   5. RestartPolicy semantics (§8)
 *   6. Terminal state absorption (§3.2)
 *   7. Provider profile consistency
 *   8. SandboxStatus bridge mapping
 *   9. Full lifecycle walkthroughs
 *  10. Invalid transition handling
 */

import { describe, it, expect } from 'vitest';
import {
  ContainerGroupState,
  ContainerStateValue,
  ECI_TRANSITIONS,
  PODMAN_TRANSITIONS,
  ALL_TRANSITIONS,
  transition,
  evaluateRestartPolicy,
  TERMINAL_STATES,
  isTerminal,
  isTransient,
  TRANSIENT_STATES,
  API_PRECONDITIONS,
  canApplyOperation,
  isDeleteAllowed,
  checkNoResurrection,
  checkRestartLegality,
  checkUpdateLegality,
  checkDeleteLegality,
  checkContainerCGRunning,
  verifyTransitionSequence,
  validateProfile,
  toSandboxStatus,
  fromSandboxStatus,
  toLegacyLifecycle,
  profileForPlatform,
  ECI_PROFILE,
  PODMAN_PROFILE,
  STUB_PROFILE,
} from '../../../src/core/provider/container-lifecycle.ts';
import { SandboxStatus } from '../../../src/features/sandbox/types.ts';
import type { ContainerLifecycleProfile } from '../../../src/core/provider/container-lifecycle.ts';
import type { RestartPolicy, ApiOperation } from '../../../src/core/provider/container-lifecycle.ts';

// ─── 1. State set completeness ───

describe('ContainerGroupState set', () => {
  it('has 13 states (11 ECI + Stopped + Paused)', () => {
    const states = Object.values(ContainerGroupState);
    expect(states).toHaveLength(13);
  });

  it('includes all ECI states from the formal model §1', () => {
    const eciStates = [
      'Scheduling', 'ScheduleFailed', 'Pending', 'Running',
      'Succeeded', 'Failed', 'Restarting', 'Updating',
      'Terminating', 'Expired', 'Deleted',
    ];
    for (const s of eciStates) {
      expect(ContainerGroupState[s as keyof typeof ContainerGroupState]).toBe(s);
    }
  });

  it('includes Podman-specific states', () => {
    expect(ContainerGroupState.Stopped).toBe('Stopped');
    expect(ContainerGroupState.Paused).toBe('Paused');
  });

  it('has 5 terminal states (§3.2)', () => {
    expect(TERMINAL_STATES.size).toBe(5);
    expect(TERMINAL_STATES.has(ContainerGroupState.ScheduleFailed)).toBe(true);
    expect(TERMINAL_STATES.has(ContainerGroupState.Succeeded)).toBe(true);
    expect(TERMINAL_STATES.has(ContainerGroupState.Failed)).toBe(true);
    expect(TERMINAL_STATES.has(ContainerGroupState.Expired)).toBe(true);
    expect(TERMINAL_STATES.has(ContainerGroupState.Deleted)).toBe(true);
  });

  it('has 5 transient states (§5.2)', () => {
    expect(TRANSIENT_STATES.size).toBe(5);
    expect(TRANSIENT_STATES.has(ContainerGroupState.Scheduling)).toBe(true);
    expect(TRANSIENT_STATES.has(ContainerGroupState.Pending)).toBe(true);
    expect(TRANSIENT_STATES.has(ContainerGroupState.Restarting)).toBe(true);
    expect(TRANSIENT_STATES.has(ContainerGroupState.Updating)).toBe(true);
    expect(TRANSIENT_STATES.has(ContainerGroupState.Terminating)).toBe(true);
  });
});

// ─── 2. Transition table completeness ───

describe('ECI transition table (§3.1, 18 rules)', () => {
  it('has exactly 18 ECI transitions', () => {
    expect(ECI_TRANSITIONS).toHaveLength(18);
  });

  // Verify each rule T1-T18 is present
  const expectedRules = [
    { rule: 'T1', from: 'Scheduling', to: 'Pending' },
    { rule: 'T2', from: 'Scheduling', to: 'ScheduleFailed' },
    { rule: 'T3', from: 'Pending', to: 'Running' },
    { rule: 'T4', from: 'Pending', to: 'Failed' },
    { rule: 'T5', from: 'Running', to: 'Succeeded' },
    { rule: 'T6', from: 'Running', to: 'Failed' },
    { rule: 'T7', from: 'Running', to: 'Restarting' },
    { rule: 'T8', from: 'Running', to: 'Updating' },
    { rule: 'T9', from: 'Running', to: 'Terminating' },
    { rule: 'T10', from: 'Running', to: 'Expired' },
    { rule: 'T11', from: 'Restarting', to: 'Pending' },
    { rule: 'T12', from: 'Restarting', to: 'Failed' },
    { rule: 'T13', from: 'Updating', to: 'Running' },
    { rule: 'T14', from: 'Updating', to: 'Running' },
    { rule: 'T15', from: 'Terminating', to: 'Deleted' },
    { rule: 'T16', from: 'Restarting', to: 'Terminating' },
    { rule: 'T17', from: 'Updating', to: 'Terminating' },
    { rule: 'T18', from: 'Pending', to: 'Terminating' },
  ];

  for (const expected of expectedRules) {
    it(`T${expected.rule.slice(1)}: ${expected.from} → ${expected.to}`, () => {
      const found = ECI_TRANSITIONS.find(t => t.rule === expected.rule);
      expect(found, `Rule ${expected.rule} not found`).toBeDefined();
      expect(found!.from).toBe(expected.from);
      expect(found!.to).toBe(expected.to);
    });
  }
});

describe('Podman transition table (7 rules)', () => {
  it('has 7 Podman-specific transitions', () => {
    expect(PODMAN_TRANSITIONS).toHaveLength(7);
  });

  it('P1: Running + Stop → Stopped', () => {
    const t = PODMAN_TRANSITIONS.find(t => t.rule === 'P1');
    expect(t!.from).toBe(ContainerGroupState.Running);
    expect(t!.to).toBe(ContainerGroupState.Stopped);
    expect(t!.trigger.kind).toBe('Api');
  });

  it('P2: Stopped + Start → Running', () => {
    const t = PODMAN_TRANSITIONS.find(t => t.rule === 'P2');
    expect(t!.from).toBe(ContainerGroupState.Stopped);
    expect(t!.to).toBe(ContainerGroupState.Running);
  });

  it('P3: Running + Pause → Paused', () => {
    const t = PODMAN_TRANSITIONS.find(t => t.rule === 'P3');
    expect(t!.from).toBe(ContainerGroupState.Running);
    expect(t!.to).toBe(ContainerGroupState.Paused);
  });

  it('P4: Paused + Unpause → Running', () => {
    const t = PODMAN_TRANSITIONS.find(t => t.rule === 'P4');
    expect(t!.from).toBe(ContainerGroupState.Paused);
    expect(t!.to).toBe(ContainerGroupState.Running);
  });

  it('ALL_TRANSITIONS = ECI + Podman', () => {
    expect(ALL_TRANSITIONS).toHaveLength(25);
  });
});

// ─── 3. Transition function δ ───

describe('transition() function', () => {
  describe('ECI happy path (System events)', () => {
    it('Scheduling → Pending → Running → Succeeded', () => {
      let s = ContainerGroupState.Scheduling;
      s = transition(s, { kind: 'System', event: 'ScheduleSucceeded' });
      expect(s).toBe(ContainerGroupState.Pending);
      s = transition(s, { kind: 'System', event: 'InitSucceeded' });
      expect(s).toBe(ContainerGroupState.Running);
      s = transition(s, { kind: 'System', event: 'ContainerExited0' });
      expect(s).toBe(ContainerGroupState.Succeeded);
    });

    it('Scheduling → ScheduleFailed (T2)', () => {
      const s = transition(ContainerGroupState.Scheduling, { kind: 'System', event: 'ScheduleFailed' });
      expect(s).toBe(ContainerGroupState.ScheduleFailed);
    });

    it('Pending → Failed (T4)', () => {
      const s = transition(ContainerGroupState.Pending, { kind: 'System', event: 'InitFailed' });
      expect(s).toBe(ContainerGroupState.Failed);
    });

    it('Running → Expired (T10)', () => {
      const s = transition(ContainerGroupState.Running, { kind: 'System', event: 'InstanceExpired' });
      expect(s).toBe(ContainerGroupState.Expired);
    });
  });

  describe('ECI API-driven transitions', () => {
    it('Running + RestartContainerGroup → Restarting (T7)', () => {
      const s = transition(ContainerGroupState.Running, { kind: 'Api', operation: 'RestartContainerGroup' });
      expect(s).toBe(ContainerGroupState.Restarting);
    });

    it('Running + UpdateContainerGroup → Updating (T8)', () => {
      const s = transition(ContainerGroupState.Running, { kind: 'Api', operation: 'UpdateContainerGroup' });
      expect(s).toBe(ContainerGroupState.Updating);
    });

    it('Running + DeleteContainerGroup → Terminating (T9)', () => {
      const s = transition(ContainerGroupState.Running, { kind: 'Api', operation: 'DeleteContainerGroup' });
      expect(s).toBe(ContainerGroupState.Terminating);
    });

    it('Restarting + DeleteContainerGroup → Terminating (T16)', () => {
      const s = transition(ContainerGroupState.Restarting, { kind: 'Api', operation: 'DeleteContainerGroup' });
      expect(s).toBe(ContainerGroupState.Terminating);
    });

    it('Updating + DeleteContainerGroup → Terminating (T17)', () => {
      const s = transition(ContainerGroupState.Updating, { kind: 'Api', operation: 'DeleteContainerGroup' });
      expect(s).toBe(ContainerGroupState.Terminating);
    });

    it('Pending + DeleteContainerGroup → Terminating (T18)', () => {
      const s = transition(ContainerGroupState.Pending, { kind: 'Api', operation: 'DeleteContainerGroup' });
      expect(s).toBe(ContainerGroupState.Terminating);
    });
  });

  describe('Podman transitions', () => {
    it('Running + Stop → Stopped (P1)', () => {
      const s = transition(ContainerGroupState.Running, { kind: 'Api', operation: 'StopContainerGroup' });
      expect(s).toBe(ContainerGroupState.Stopped);
    });

    it('Stopped + Start → Running (P2)', () => {
      const s = transition(ContainerGroupState.Stopped, { kind: 'Api', operation: 'StartContainerGroup' });
      expect(s).toBe(ContainerGroupState.Running);
    });

    it('Running + Pause → Paused → Unpause → Running (P3, P4)', () => {
      let s = transition(ContainerGroupState.Running, { kind: 'Api', operation: 'PauseContainerGroup' });
      expect(s).toBe(ContainerGroupState.Paused);
      s = transition(s, { kind: 'Api', operation: 'UnpauseContainerGroup' });
      expect(s).toBe(ContainerGroupState.Running);
    });

    it('Stopped + Delete → Terminating (P5)', () => {
      const s = transition(ContainerGroupState.Stopped, { kind: 'Api', operation: 'DeleteContainerGroup' });
      expect(s).toBe(ContainerGroupState.Terminating);
    });

    it('Paused + Stop → Stopped (P6)', () => {
      const s = transition(ContainerGroupState.Paused, { kind: 'Api', operation: 'StopContainerGroup' });
      expect(s).toBe(ContainerGroupState.Stopped);
    });

    it('Paused + Delete → Terminating (P7)', () => {
      const s = transition(ContainerGroupState.Paused, { kind: 'Api', operation: 'DeleteContainerGroup' });
      expect(s).toBe(ContainerGroupState.Terminating);
    });
  });

  describe('RestartPolicy trigger', () => {
    it('routes to evaluateRestartPolicy when kind=RestartPolicy', () => {
      // Always: exit(0) → Restarting
      const s = transition(ContainerGroupState.Running, { kind: 'RestartPolicy', exitCode: 0, policy: 'Always' });
      expect(s).toBe(ContainerGroupState.Restarting);
    });

    it('no-op when not Running', () => {
      const s = transition(ContainerGroupState.Pending, { kind: 'RestartPolicy', exitCode: 0, policy: 'Always' });
      expect(s).toBe(ContainerGroupState.Pending); // unchanged
    });
  });

  describe('invalid transitions return same state', () => {
    it('terminal state absorbs any trigger', () => {
      for (const ts of TERMINAL_STATES) {
        const s = transition(ts, { kind: 'System', event: 'ScheduleSucceeded' });
        expect(s).toBe(ts);
      }
    });

    it('Terminating + Stop → Terminating (no such transition)', () => {
      const s = transition(ContainerGroupState.Terminating, { kind: 'Api', operation: 'StopContainerGroup' });
      expect(s).toBe(ContainerGroupState.Terminating);
    });

    it('Stopped + RestartContainerGroup → Stopped (ECI doesn\'t support Stopped restart by API)', () => {
      const s = transition(ContainerGroupState.Stopped, { kind: 'Api', operation: 'RestartContainerGroup' });
      expect(s).toBe(ContainerGroupState.Stopped);
    });

    it('Scheduling + Pause → Scheduling (no such transition)', () => {
      const s = transition(ContainerGroupState.Scheduling, { kind: 'Api', operation: 'PauseContainerGroup' });
      expect(s).toBe(ContainerGroupState.Scheduling);
    });
  });
});

// ─── 4. RestartPolicy evaluation (§8) ───

describe('evaluateRestartPolicy (§8)', () => {
  it('Always: exit(0) → Restarting', () => {
    expect(evaluateRestartPolicy(ContainerGroupState.Running, 0, 'Always')).toBe(ContainerGroupState.Restarting);
  });

  it('Always: exit(1) → Restarting', () => {
    expect(evaluateRestartPolicy(ContainerGroupState.Running, 1, 'Always')).toBe(ContainerGroupState.Restarting);
  });

  it('OnFailure: exit(0) → Succeeded', () => {
    expect(evaluateRestartPolicy(ContainerGroupState.Running, 0, 'OnFailure')).toBe(ContainerGroupState.Succeeded);
  });

  it('OnFailure: exit(1) → Restarting', () => {
    expect(evaluateRestartPolicy(ContainerGroupState.Running, 1, 'OnFailure')).toBe(ContainerGroupState.Restarting);
  });

  it('Never: exit(0) → Succeeded', () => {
    expect(evaluateRestartPolicy(ContainerGroupState.Running, 0, 'Never')).toBe(ContainerGroupState.Succeeded);
  });

  it('Never: exit(1) → Failed', () => {
    expect(evaluateRestartPolicy(ContainerGroupState.Running, 1, 'Never')).toBe(ContainerGroupState.Failed);
  });

  it('non-Running state unchanged', () => {
    expect(evaluateRestartPolicy(ContainerGroupState.Pending, 1, 'Always')).toBe(ContainerGroupState.Pending);
    expect(evaluateRestartPolicy(ContainerGroupState.Terminating, 0, 'Always')).toBe(ContainerGroupState.Terminating);
  });

  // Full RestartPolicy matrix (§8 table)
  const matrix: Array<{ policy: RestartPolicy; exitCode: number; expected: ContainerGroupState }> = [
    { policy: 'Always', exitCode: 0, expected: ContainerGroupState.Restarting },
    { policy: 'Always', exitCode: 1, expected: ContainerGroupState.Restarting },
    { policy: 'Always', exitCode: 137, expected: ContainerGroupState.Restarting },
    { policy: 'OnFailure', exitCode: 0, expected: ContainerGroupState.Succeeded },
    { policy: 'OnFailure', exitCode: 1, expected: ContainerGroupState.Restarting },
    { policy: 'OnFailure', exitCode: 137, expected: ContainerGroupState.Restarting },
    { policy: 'Never', exitCode: 0, expected: ContainerGroupState.Succeeded },
    { policy: 'Never', exitCode: 1, expected: ContainerGroupState.Failed },
    { policy: 'Never', exitCode: 137, expected: ContainerGroupState.Failed },
  ];

  for (const { policy, exitCode, expected } of matrix) {
    it(`RestartPolicy=${policy}, exit(${exitCode}) → ${expected}`, () => {
      expect(evaluateRestartPolicy(ContainerGroupState.Running, exitCode, policy)).toBe(expected);
    });
  }
});

// ─── 5. Safety invariants P1–P5 (§5.1) ───

describe('Safety invariant P1: NoResurrection', () => {
  it('terminal state must not change', () => {
    for (const ts of TERMINAL_STATES) {
      expect(checkNoResurrection(ts, ContainerGroupState.Running)).toBe(false);
    }
  });

  it('terminal → same is allowed', () => {
    for (const ts of TERMINAL_STATES) {
      expect(checkNoResurrection(ts, ts)).toBe(true);
    }
  });

  it('non-terminal → any is allowed', () => {
    expect(checkNoResurrection(ContainerGroupState.Running, ContainerGroupState.Terminating)).toBe(true);
    expect(checkNoResurrection(ContainerGroupState.Scheduling, ContainerGroupState.Pending)).toBe(true);
  });
});

describe('Safety invariant P2: RestartLegality', () => {
  it('Restarting must come from Running', () => {
    expect(checkRestartLegality(ContainerGroupState.Running, ContainerGroupState.Restarting)).toBe(true);
  });

  it('Restarting from Scheduling is illegal', () => {
    expect(checkRestartLegality(ContainerGroupState.Scheduling, ContainerGroupState.Restarting)).toBe(false);
  });

  it('Restarting from Pending is illegal', () => {
    expect(checkRestartLegality(ContainerGroupState.Pending, ContainerGroupState.Restarting)).toBe(false);
  });

  it('non-Restarting target is always legal', () => {
    expect(checkRestartLegality(ContainerGroupState.Scheduling, ContainerGroupState.Pending)).toBe(true);
  });
});

describe('Safety invariant P3: UpdateLegality', () => {
  it('Updating must come from Running', () => {
    expect(checkUpdateLegality(ContainerGroupState.Running, ContainerGroupState.Updating)).toBe(true);
  });

  it('Updating from Pending is illegal', () => {
    expect(checkUpdateLegality(ContainerGroupState.Pending, ContainerGroupState.Updating)).toBe(false);
  });

  it('Updating from Stopped is illegal', () => {
    expect(checkUpdateLegality(ContainerGroupState.Stopped, ContainerGroupState.Updating)).toBe(false);
  });
});

describe('Safety invariant P4: DeleteLegality', () => {
  it('delete allowed from Running', () => {
    expect(checkDeleteLegality(ContainerGroupState.Running)).toBe(true);
  });

  it('delete allowed from Pending', () => {
    expect(checkDeleteLegality(ContainerGroupState.Pending)).toBe(true);
  });

  it('delete allowed from Restarting', () => {
    expect(checkDeleteLegality(ContainerGroupState.Restarting)).toBe(true);
  });

  it('delete allowed from Updating', () => {
    expect(checkDeleteLegality(ContainerGroupState.Updating)).toBe(true);
  });

  it('delete allowed from Stopped (Podman)', () => {
    expect(checkDeleteLegality(ContainerGroupState.Stopped)).toBe(true);
  });

  it('delete allowed from Paused (Podman)', () => {
    expect(checkDeleteLegality(ContainerGroupState.Paused)).toBe(true);
  });

  it('delete NOT allowed from Scheduling', () => {
    expect(checkDeleteLegality(ContainerGroupState.Scheduling)).toBe(false);
  });

  it('delete NOT allowed from Terminating', () => {
    expect(checkDeleteLegality(ContainerGroupState.Terminating)).toBe(false);
  });

  it('delete NOT allowed from terminal states', () => {
    for (const ts of TERMINAL_STATES) {
      expect(checkDeleteLegality(ts)).toBe(false);
    }
  });
});

describe('Safety invariant P5: ContainerRunning implies CGRunning', () => {
  it('container Running + CG Running → OK', () => {
    expect(checkContainerCGRunning(ContainerGroupState.Running, [ContainerStateValue.Running])).toBe(true);
  });

  it('container Running + CG not Running → violation', () => {
    expect(checkContainerCGRunning(ContainerGroupState.Pending, [ContainerStateValue.Running])).toBe(false);
  });

  it('no Running containers → always OK', () => {
    expect(checkContainerCGRunning(ContainerGroupState.Scheduling, [ContainerStateValue.Waiting])).toBe(true);
    expect(checkContainerCGRunning(ContainerGroupState.Failed, [ContainerStateValue.Terminated])).toBe(true);
  });

  it('one of multiple containers Running + CG Stopped → violation', () => {
    expect(checkContainerCGRunning(
      ContainerGroupState.Stopped,
      [ContainerStateValue.Terminated, ContainerStateValue.Running, ContainerStateValue.Waiting],
    )).toBe(false);
  });

  it('all containers Terminated + CG Failed → OK', () => {
    expect(checkContainerCGRunning(
      ContainerGroupState.Failed,
      [ContainerStateValue.Terminated, ContainerStateValue.Terminated],
    )).toBe(true);
  });
});

// ─── 6. API operation preconditions (§4) ───

describe('API operation preconditions (§4)', () => {
  it('CreateContainerGroup always allowed (new resource)', () => {
    expect(canApplyOperation(ContainerGroupState.Running, 'CreateContainerGroup')).toBe(true);
    // CreateContainerGroup doesn't need a pre-state check since it creates new resources
  });

  describe('DeleteContainerGroup', () => {
    const deleteAllowed = [ContainerGroupState.Running, ContainerGroupState.Pending,
      ContainerGroupState.Restarting, ContainerGroupState.Updating,
      ContainerGroupState.Stopped, ContainerGroupState.Paused];
    const deleteDenied = [ContainerGroupState.Scheduling, ContainerGroupState.Terminating,
      ...TERMINAL_STATES];

    for (const s of deleteAllowed) {
      it(`allowed from ${s}`, () => {
        expect(canApplyOperation(s, 'DeleteContainerGroup')).toBe(true);
      });
    }
    for (const s of deleteDenied) {
      it(`denied from ${s}`, () => {
        expect(canApplyOperation(s, 'DeleteContainerGroup')).toBe(false);
      });
    }
  });

  describe('RestartContainerGroup', () => {
    it('allowed only from Running', () => {
      expect(canApplyOperation(ContainerGroupState.Running, 'RestartContainerGroup')).toBe(true);
      expect(canApplyOperation(ContainerGroupState.Pending, 'RestartContainerGroup')).toBe(false);
      expect(canApplyOperation(ContainerGroupState.Stopped, 'RestartContainerGroup')).toBe(false);
      expect(canApplyOperation(ContainerGroupState.Restarting, 'RestartContainerGroup')).toBe(false);
    });
  });

  describe('UpdateContainerGroup', () => {
    it('allowed only from Running', () => {
      expect(canApplyOperation(ContainerGroupState.Running, 'UpdateContainerGroup')).toBe(true);
      expect(canApplyOperation(ContainerGroupState.Stopped, 'UpdateContainerGroup')).toBe(false);
      expect(canApplyOperation(ContainerGroupState.Updating, 'UpdateContainerGroup')).toBe(false);
    });
  });

  describe('StopContainerGroup (Podman)', () => {
    it('allowed from Running and Paused', () => {
      expect(canApplyOperation(ContainerGroupState.Running, 'StopContainerGroup')).toBe(true);
      expect(canApplyOperation(ContainerGroupState.Paused, 'StopContainerGroup')).toBe(true);
    });

    it('denied from Scheduling, Pending, Stopped', () => {
      expect(canApplyOperation(ContainerGroupState.Scheduling, 'StopContainerGroup')).toBe(false);
      expect(canApplyOperation(ContainerGroupState.Pending, 'StopContainerGroup')).toBe(false);
      expect(canApplyOperation(ContainerGroupState.Stopped, 'StopContainerGroup')).toBe(false);
    });
  });

  describe('StartContainerGroup (Podman)', () => {
    it('allowed only from Stopped', () => {
      expect(canApplyOperation(ContainerGroupState.Stopped, 'StartContainerGroup')).toBe(true);
      expect(canApplyOperation(ContainerGroupState.Running, 'StartContainerGroup')).toBe(false);
      expect(canApplyOperation(ContainerGroupState.Paused, 'StartContainerGroup')).toBe(false);
    });
  });
});

// ─── 7. Terminal / transient helpers ───

describe('isTerminal / isTransient', () => {
  it('isTerminal true for all 5 terminal states', () => {
    for (const ts of TERMINAL_STATES) {
      expect(isTerminal(ts)).toBe(true);
    }
  });

  it('isTerminal false for non-terminal states', () => {
    expect(isTerminal(ContainerGroupState.Scheduling)).toBe(false);
    expect(isTerminal(ContainerGroupState.Pending)).toBe(false);
    expect(isTerminal(ContainerGroupState.Running)).toBe(false);
    expect(isTerminal(ContainerGroupState.Stopped)).toBe(false);
    expect(isTerminal(ContainerGroupState.Paused)).toBe(false);
    expect(isTerminal(ContainerGroupState.Restarting)).toBe(false);
    expect(isTerminal(ContainerGroupState.Updating)).toBe(false);
    expect(isTerminal(ContainerGroupState.Terminating)).toBe(false);
  });

  it('isTransient true for Scheduling, Pending, Restarting, Updating, Terminating', () => {
    expect(isTransient(ContainerGroupState.Scheduling)).toBe(true);
    expect(isTransient(ContainerGroupState.Pending)).toBe(true);
    expect(isTransient(ContainerGroupState.Restarting)).toBe(true);
    expect(isTransient(ContainerGroupState.Updating)).toBe(true);
    expect(isTransient(ContainerGroupState.Terminating)).toBe(true);
  });

  it('isTransient false for steady/terminal states', () => {
    expect(isTransient(ContainerGroupState.Running)).toBe(false);
    expect(isTransient(ContainerGroupState.Stopped)).toBe(false);
    expect(isTransient(ContainerGroupState.Paused)).toBe(false);
    for (const ts of TERMINAL_STATES) {
      expect(isTransient(ts)).toBe(false);
    }
  });
});

// ─── 8. Provider lifecycle profiles ───

describe('ContainerLifecycleProfile', () => {
  describe('ECI_PROFILE', () => {
    it('matches the formal model', () => {
      expect(ECI_PROFILE.stopIsDelete).toBe(true);
      expect(ECI_PROFILE.startable).toBe(false);
      expect(ECI_PROFILE.healthProbes).toBe(false);
      expect(ECI_PROFILE.asyncInit).toBe(true);
      expect(ECI_PROFILE.supportsRestart).toBe(true);
      expect(ECI_PROFILE.supportsUpdate).toBe(true);
      expect(ECI_PROFILE.supportsExec).toBe(true);
    });

    it('has 11 reachable states', () => {
      expect(ECI_PROFILE.reachableStates.size).toBe(11);
    });

    it('does NOT include Stopped or Paused', () => {
      expect(ECI_PROFILE.reachableStates.has(ContainerGroupState.Stopped)).toBe(false);
      expect(ECI_PROFILE.reachableStates.has(ContainerGroupState.Paused)).toBe(false);
    });

    it('passes validateProfile', () => {
      expect(validateProfile(ECI_PROFILE)).toBeNull();
    });
  });

  describe('PODMAN_PROFILE', () => {
    it('has correct capabilities', () => {
      expect(PODMAN_PROFILE.stopIsDelete).toBe(false);
      expect(PODMAN_PROFILE.startable).toBe(true);
      expect(PODMAN_PROFILE.healthProbes).toBe(true);
      expect(PODMAN_PROFILE.asyncInit).toBe(false);
      expect(PODMAN_PROFILE.supportsRestart).toBe(false);
      expect(PODMAN_PROFILE.supportsUpdate).toBe(false);
      expect(PODMAN_PROFILE.supportsExec).toBe(true);
    });

    it('includes Stopped and Paused', () => {
      expect(PODMAN_PROFILE.reachableStates.has(ContainerGroupState.Stopped)).toBe(true);
      expect(PODMAN_PROFILE.reachableStates.has(ContainerGroupState.Paused)).toBe(true);
    });

    it('does NOT include Scheduling (sync init)', () => {
      expect(PODMAN_PROFILE.reachableStates.has(ContainerGroupState.Scheduling)).toBe(false);
    });

    it('passes validateProfile', () => {
      expect(validateProfile(PODMAN_PROFILE)).toBeNull();
    });
  });

  describe('STUB_PROFILE', () => {
    it('has minimal capabilities', () => {
      expect(STUB_PROFILE.stopIsDelete).toBe(false);
      expect(STUB_PROFILE.startable).toBe(true);
      expect(STUB_PROFILE.healthProbes).toBe(false);
      expect(STUB_PROFILE.asyncInit).toBe(false);
      expect(STUB_PROFILE.supportsRestart).toBe(false);
      expect(STUB_PROFILE.supportsUpdate).toBe(false);
      expect(STUB_PROFILE.supportsExec).toBe(false);
    });

    it('has 4 reachable states', () => {
      expect(STUB_PROFILE.reachableStates.size).toBe(4);
    });

    it('passes validateProfile', () => {
      expect(validateProfile(STUB_PROFILE)).toBeNull();
    });
  });

  describe('validateProfile', () => {
    it('detects stopIsDelete + Stopped contradiction', () => {
      const bad: ContainerLifecycleProfile = {
        ...ECI_PROFILE,
        reachableStates: new Set([...ECI_PROFILE.reachableStates, ContainerGroupState.Stopped]),
      };
      expect(validateProfile(bad)).toContain('stopIsDelete');
    });

    it('detects startable without Stopped', () => {
      const bad: ContainerLifecycleProfile = {
        ...PODMAN_PROFILE,
        reachableStates: new Set([...PODMAN_PROFILE.reachableStates].filter(s => s !== ContainerGroupState.Stopped)),
      };
      expect(validateProfile(bad)).toContain('startable');
    });

    it('detects asyncInit without Scheduling', () => {
      const bad: ContainerLifecycleProfile = {
        ...ECI_PROFILE,
        reachableStates: new Set([...ECI_PROFILE.reachableStates].filter(s => s !== ContainerGroupState.Scheduling)),
      };
      expect(validateProfile(bad)).toContain('asyncInit');
    });

    it('detects supportsRestart without Restarting', () => {
      const bad: ContainerLifecycleProfile = {
        ...ECI_PROFILE,
        reachableStates: new Set([...ECI_PROFILE.reachableStates].filter(s => s !== ContainerGroupState.Restarting)),
      };
      expect(validateProfile(bad)).toContain('supportsRestart');
    });

    it('detects supportsUpdate without Updating', () => {
      const bad: ContainerLifecycleProfile = {
        ...ECI_PROFILE,
        reachableStates: new Set([...ECI_PROFILE.reachableStates].filter(s => s !== ContainerGroupState.Updating)),
      };
      expect(validateProfile(bad)).toContain('supportsUpdate');
    });
  });

  describe('profileForPlatform', () => {
    it('returns ECI_PROFILE for alibaba', () => {
      expect(profileForPlatform('alibaba')).toBe(ECI_PROFILE);
    });

    it('returns PODMAN_PROFILE for podman', () => {
      expect(profileForPlatform('podman')).toBe(PODMAN_PROFILE);
    });

    it('returns STUB_PROFILE for stub', () => {
      expect(profileForPlatform('stub')).toBe(STUB_PROFILE);
    });

    it('returns STUB_PROFILE for unknown platforms', () => {
      expect(profileForPlatform('aws')).toBe(STUB_PROFILE);
      expect(profileForPlatform('gcp')).toBe(STUB_PROFILE);
    });
  });
});

// ─── 9. toLegacyLifecycle backward compat ───

describe('toLegacyLifecycle', () => {
  it('derives legacy 4-boolean from profile', () => {
    const legacy = toLegacyLifecycle(ECI_PROFILE);
    expect(legacy.stopIsDelete).toBe(true);
    expect(legacy.startable).toBe(false);
    expect(legacy.healthProbes).toBe(false);
    expect(legacy.asyncInit).toBe(true);
  });

  it('round-trips correctly for all profiles', () => {
    for (const profile of [ECI_PROFILE, PODMAN_PROFILE, STUB_PROFILE]) {
      const legacy = toLegacyLifecycle(profile);
      expect(legacy.stopIsDelete).toBe(profile.stopIsDelete);
      expect(legacy.startable).toBe(profile.startable);
      expect(legacy.healthProbes).toBe(profile.healthProbes);
      expect(legacy.asyncInit).toBe(profile.asyncInit);
    }
  });
});

// ─── 10. SandboxStatus bridge (§11) ───

describe('toSandboxStatus mapping', () => {
  it('maps every ContainerGroupState to a SandboxStatus', () => {
    for (const state of Object.values(ContainerGroupState)) {
      const sb = toSandboxStatus(state as ContainerGroupState);
      expect(Object.values(SandboxStatus)).toContain(sb);
    }
  });

  it('Scheduling, Pending, Restarting → Scheduling', () => {
    expect(toSandboxStatus(ContainerGroupState.Scheduling)).toBe(SandboxStatus.Scheduling);
    expect(toSandboxStatus(ContainerGroupState.Pending)).toBe(SandboxStatus.Scheduling);
    expect(toSandboxStatus(ContainerGroupState.Restarting)).toBe(SandboxStatus.Scheduling);
  });

  it('Running, Updating → Running', () => {
    expect(toSandboxStatus(ContainerGroupState.Running)).toBe(SandboxStatus.Running);
    expect(toSandboxStatus(ContainerGroupState.Updating)).toBe(SandboxStatus.Running);
  });

  it('Stopped, Paused → Succeeded (11-state model)', () => {
    expect(toSandboxStatus(ContainerGroupState.Stopped)).toBe(SandboxStatus.Succeeded);
    expect(toSandboxStatus(ContainerGroupState.Paused)).toBe(SandboxStatus.Succeeded);
  });

  it('Terminating → Terminating', () => {
    expect(toSandboxStatus(ContainerGroupState.Terminating)).toBe(SandboxStatus.Terminating);
  });

  it('Each terminal state maps individually', () => {
    expect(toSandboxStatus(ContainerGroupState.ScheduleFailed)).toBe(SandboxStatus.ScheduleFailed);
    expect(toSandboxStatus(ContainerGroupState.Failed)).toBe(SandboxStatus.Failed);
    expect(toSandboxStatus(ContainerGroupState.Succeeded)).toBe(SandboxStatus.Succeeded);
    expect(toSandboxStatus(ContainerGroupState.Expired)).toBe(SandboxStatus.Expired);
  });

  it('Deleted → Deleted', () => {
    expect(toSandboxStatus(ContainerGroupState.Deleted)).toBe(SandboxStatus.Deleted);
  });
});

describe('fromSandboxStatus reverse mapping', () => {
  it('every SandboxStatus has at least 1 concrete state', () => {
    for (const status of Object.values(SandboxStatus)) {
      const states = fromSandboxStatus(status);
      expect(states.length, `SandboxStatus.${status} has no concrete states`).toBeGreaterThan(0);
    }
  });

  it('Scheduling maps to Scheduling, Pending, Restarting', () => {
    const states = fromSandboxStatus(SandboxStatus.Scheduling);
    expect(states).toContain(ContainerGroupState.Scheduling);
    expect(states).toContain(ContainerGroupState.Pending);
    expect(states).toContain(ContainerGroupState.Restarting);
  });

  it('Pending maps to Scheduling, Pending only', () => {
    const states = fromSandboxStatus(SandboxStatus.Pending);
    expect(states).toContain(ContainerGroupState.Scheduling);
    expect(states).toContain(ContainerGroupState.Pending);
  });

  it('Running maps to Running, Updating', () => {
    const states = fromSandboxStatus(SandboxStatus.Running);
    expect(states).toContain(ContainerGroupState.Running);
    expect(states).toContain(ContainerGroupState.Updating);
  });

  it('round-trip: toSandboxStatus → fromSandboxStatus contains original', () => {
    for (const state of Object.values(ContainerGroupState)) {
      const sb = toSandboxStatus(state as ContainerGroupState);
      const back = fromSandboxStatus(sb);
      expect(back, `Round-trip failed for ${state}`).toContain(state as ContainerGroupState);
    }
  });

  it('Succeeded maps to Stopped and Paused', () => {
    const states = fromSandboxStatus(SandboxStatus.Succeeded);
    expect(states).toContain(ContainerGroupState.Stopped);
    expect(states).toContain(ContainerGroupState.Paused);
  });
});

// ─── 11. Full lifecycle walkthroughs ───

describe('ECI full lifecycle walkthrough', () => {
  it('happy path: Create → Running → Succeeded', () => {
    const path: ContainerGroupState[] = [ContainerGroupState.Scheduling];
    path.push(transition(path[path.length - 1]!, { kind: 'System', event: 'ScheduleSucceeded' }));
    path.push(transition(path[path.length - 1]!, { kind: 'System', event: 'InitSucceeded' }));
    path.push(transition(path[path.length - 1]!, { kind: 'RestartPolicy', exitCode: 0, policy: 'OnFailure' }));

    expect(path).toEqual([
      ContainerGroupState.Scheduling,
      ContainerGroupState.Pending,
      ContainerGroupState.Running,
      ContainerGroupState.Succeeded,
    ]);
  });

  it('sad path: Scheduling → ScheduleFailed', () => {
    const s = transition(ContainerGroupState.Scheduling, { kind: 'System', event: 'ScheduleFailed' });
    expect(s).toBe(ContainerGroupState.ScheduleFailed);
    // Terminal — further transitions no-op
    expect(transition(s, { kind: 'System', event: 'ScheduleSucceeded' })).toBe(ContainerGroupState.ScheduleFailed);
  });

  it('restart cycle: Running → Restarting → Pending → Running', () => {
    let s = transition(ContainerGroupState.Running, { kind: 'Api', operation: 'RestartContainerGroup' });
    expect(s).toBe(ContainerGroupState.Restarting);
    s = transition(s, { kind: 'System', event: 'RestartSucceeded' });
    expect(s).toBe(ContainerGroupState.Pending);
    s = transition(s, { kind: 'System', event: 'InitSucceeded' });
    expect(s).toBe(ContainerGroupState.Running);
  });

  it('restart failure: Running → Restarting → Failed', () => {
    let s = transition(ContainerGroupState.Running, { kind: 'Api', operation: 'RestartContainerGroup' });
    expect(s).toBe(ContainerGroupState.Restarting);
    s = transition(s, { kind: 'System', event: 'RestartFailed' });
    expect(s).toBe(ContainerGroupState.Failed);
    expect(isTerminal(s)).toBe(true);
  });

  it('delete during pending: Pending → Terminating → Deleted', () => {
    let s = transition(ContainerGroupState.Pending, { kind: 'Api', operation: 'DeleteContainerGroup' });
    expect(s).toBe(ContainerGroupState.Terminating);
    s = transition(s, { kind: 'System', event: 'CleanupComplete' });
    expect(s).toBe(ContainerGroupState.Deleted);
  });

  it('update cycle: Running → Updating → Running', () => {
    let s = transition(ContainerGroupState.Running, { kind: 'Api', operation: 'UpdateContainerGroup' });
    expect(s).toBe(ContainerGroupState.Updating);
    s = transition(s, { kind: 'System', event: 'UpdateSucceeded' });
    expect(s).toBe(ContainerGroupState.Running);
  });

  it('update failed → rollback to Running (T14)', () => {
    let s = transition(ContainerGroupState.Running, { kind: 'Api', operation: 'UpdateContainerGroup' });
    expect(s).toBe(ContainerGroupState.Updating);
    s = transition(s, { kind: 'System', event: 'UpdateFailed' });
    expect(s).toBe(ContainerGroupState.Running); // rollback
  });

  it('delete during update: Updating → Terminating → Deleted', () => {
    let s = transition(ContainerGroupState.Running, { kind: 'Api', operation: 'UpdateContainerGroup' });
    s = transition(s, { kind: 'Api', operation: 'DeleteContainerGroup' });
    expect(s).toBe(ContainerGroupState.Terminating);
    s = transition(s, { kind: 'System', event: 'CleanupComplete' });
    expect(s).toBe(ContainerGroupState.Deleted);
  });

  it('delete during restart: Restarting → Terminating → Deleted', () => {
    let s = transition(ContainerGroupState.Running, { kind: 'Api', operation: 'RestartContainerGroup' });
    s = transition(s, { kind: 'Api', operation: 'DeleteContainerGroup' });
    expect(s).toBe(ContainerGroupState.Terminating);
    s = transition(s, { kind: 'System', event: 'CleanupComplete' });
    expect(s).toBe(ContainerGroupState.Deleted);
  });

  it('preemptible expiry: Running → Expired (T10)', () => {
    const s = transition(ContainerGroupState.Running, { kind: 'System', event: 'InstanceExpired' });
    expect(s).toBe(ContainerGroupState.Expired);
    expect(isTerminal(s)).toBe(true);
  });
});

describe('Podman full lifecycle walkthrough', () => {
  it('happy path: Pending → Running → Stopped → Running → Deleted', () => {
    const path: ContainerGroupState[] = [ContainerGroupState.Pending];
    path.push(transition(path[path.length - 1]!, { kind: 'System', event: 'InitSucceeded' }));
    expect(path[path.length - 1]).toBe(ContainerGroupState.Running);

    path.push(transition(path[path.length - 1]!, { kind: 'Api', operation: 'StopContainerGroup' }));
    expect(path[path.length - 1]).toBe(ContainerGroupState.Stopped);

    path.push(transition(path[path.length - 1]!, { kind: 'Api', operation: 'StartContainerGroup' }));
    expect(path[path.length - 1]).toBe(ContainerGroupState.Running);

    path.push(transition(path[path.length - 1]!, { kind: 'Api', operation: 'DeleteContainerGroup' }));
    expect(path[path.length - 1]).toBe(ContainerGroupState.Terminating);

    path.push(transition(path[path.length - 1]!, { kind: 'System', event: 'CleanupComplete' }));
    expect(path[path.length - 1]).toBe(ContainerGroupState.Deleted);
  });

  it('pause cycle: Running → Paused → Running', () => {
    let s = transition(ContainerGroupState.Running, { kind: 'Api', operation: 'PauseContainerGroup' });
    expect(s).toBe(ContainerGroupState.Paused);
    s = transition(s, { kind: 'Api', operation: 'UnpauseContainerGroup' });
    expect(s).toBe(ContainerGroupState.Running);
  });

  it('pause + stop: Running → Paused → Stopped', () => {
    let s = transition(ContainerGroupState.Running, { kind: 'Api', operation: 'PauseContainerGroup' });
    s = transition(s, { kind: 'Api', operation: 'StopContainerGroup' });
    expect(s).toBe(ContainerGroupState.Stopped);
  });

  it('pause + delete: Running → Paused → Terminating', () => {
    let s = transition(ContainerGroupState.Running, { kind: 'Api', operation: 'PauseContainerGroup' });
    s = transition(s, { kind: 'Api', operation: 'DeleteContainerGroup' });
    expect(s).toBe(ContainerGroupState.Terminating);
  });
});

// ─── 12. verifyTransitionSequence ───

describe('verifyTransitionSequence', () => {
  it('passes for a valid ECI lifecycle', () => {
    const steps = [
      { from: ContainerGroupState.Scheduling, to: ContainerGroupState.Pending },
      { from: ContainerGroupState.Pending, to: ContainerGroupState.Running },
      { from: ContainerGroupState.Running, to: ContainerGroupState.Succeeded },
    ];
    expect(verifyTransitionSequence(steps)).toBeNull();
  });

  it('detects NoResurrection violation', () => {
    const steps = [
      { from: ContainerGroupState.Deleted, to: ContainerGroupState.Running },
    ];
    expect(verifyTransitionSequence(steps)).toBe('P1: NoResurrection');
  });

  it('detects RestartLegality violation', () => {
    const steps = [
      { from: ContainerGroupState.Scheduling, to: ContainerGroupState.Restarting },
    ];
    expect(verifyTransitionSequence(steps)).toContain('P2');
  });

  it('detects UpdateLegality violation', () => {
    const steps = [
      { from: ContainerGroupState.Stopped, to: ContainerGroupState.Updating },
    ];
    expect(verifyTransitionSequence(steps)).toContain('P3');
  });

  it('passes for a valid Podman lifecycle', () => {
    const steps = [
      { from: ContainerGroupState.Pending, to: ContainerGroupState.Running },
      { from: ContainerGroupState.Running, to: ContainerGroupState.Stopped },
      { from: ContainerGroupState.Stopped, to: ContainerGroupState.Running },
      { from: ContainerGroupState.Running, to: ContainerGroupState.Paused },
      { from: ContainerGroupState.Paused, to: ContainerGroupState.Running },
    ];
    expect(verifyTransitionSequence(steps)).toBeNull();
  });
});

// ─── 13. Cross-provider isolation ───

describe('cross-provider state isolation', () => {
  it('ECI profile does not overlap Podman-only states', () => {
    const eciStates = ECI_PROFILE.reachableStates;
    expect(eciStates.has(ContainerGroupState.Stopped)).toBe(false);
    expect(eciStates.has(ContainerGroupState.Paused)).toBe(false);
  });

  it('Podman profile does not include ECI-only states', () => {
    const podmanStates = PODMAN_PROFILE.reachableStates;
    expect(podmanStates.has(ContainerGroupState.Scheduling)).toBe(false);
    expect(podmanStates.has(ContainerGroupState.ScheduleFailed)).toBe(false);
    expect(podmanStates.has(ContainerGroupState.Succeeded)).toBe(false);
    expect(podmanStates.has(ContainerGroupState.Expired)).toBe(false);
    expect(podmanStates.has(ContainerGroupState.Restarting)).toBe(false);
    expect(podmanStates.has(ContainerGroupState.Updating)).toBe(false);
  });

  it('Stub profile is minimal', () => {
    const stubStates = STUB_PROFILE.reachableStates;
    expect(stubStates.size).toBe(4);
    expect(stubStates.has(ContainerGroupState.Running)).toBe(true);
    expect(stubStates.has(ContainerGroupState.Stopped)).toBe(true);
    expect(stubStates.has(ContainerGroupState.Terminating)).toBe(true);
    expect(stubStates.has(ContainerGroupState.Deleted)).toBe(true);
  });
});

// ─── 14. Invariant: no dead-end non-terminal states ───

describe('liveness: every non-terminal state has a path to some terminal', () => {
  // For each non-terminal state, there must exist a sequence of valid
  // transitions that reaches a terminal state.
  const pathsToTerminal: Partial<Record<ContainerGroupState, ContainerGroupState[]>> = {
    [ContainerGroupState.Scheduling]: [
      ContainerGroupState.Scheduling,
      ContainerGroupState.Pending,
      ContainerGroupState.Running,
      ContainerGroupState.Succeeded,
    ],
    [ContainerGroupState.Pending]: [
      ContainerGroupState.Pending,
      ContainerGroupState.Running,
      ContainerGroupState.Succeeded,
    ],
    [ContainerGroupState.Running]: [
      ContainerGroupState.Running,
      ContainerGroupState.Succeeded,
    ],
    [ContainerGroupState.Updating]: [
      ContainerGroupState.Updating,
      ContainerGroupState.Running,
      ContainerGroupState.Succeeded,
    ],
    [ContainerGroupState.Restarting]: [
      ContainerGroupState.Restarting,
      ContainerGroupState.Pending,
      ContainerGroupState.Running,
      ContainerGroupState.Succeeded,
    ],
    [ContainerGroupState.Stopped]: [
      ContainerGroupState.Stopped,
      ContainerGroupState.Running,
      ContainerGroupState.Terminating,
      ContainerGroupState.Deleted,
    ],
    [ContainerGroupState.Paused]: [
      ContainerGroupState.Paused,
      ContainerGroupState.Running,
      ContainerGroupState.Terminating,
      ContainerGroupState.Deleted,
    ],
    [ContainerGroupState.Terminating]: [
      ContainerGroupState.Terminating,
      ContainerGroupState.Deleted,
    ],
  };

  for (const [startState, expectedPath] of Object.entries(pathsToTerminal)) {
    it(`${startState} can reach a terminal state`, () => {
      let s = startState as ContainerGroupState;
      for (let i = 1; i < expectedPath!.length; i++) {
        const target = expectedPath![i]!;
        // Find a trigger that transitions from s to target
        const t = ALL_TRANSITIONS.find(tr => tr.from === s && tr.to === target);
        expect(t, `No transition from ${s} to ${target}`).toBeDefined();
        s = transition(s, t!.trigger);
        expect(s).toBe(target);
      }
      expect(isTerminal(s)).toBe(true);
    });
  }
});

// ─── 15. All transitions respect invariants ───

describe('all known transitions respect safety invariants', () => {
  it('every ECI transition respects P1-P3', () => {
    for (const t of ECI_TRANSITIONS) {
      expect(checkNoResurrection(t.from, t.to),
        `${t.rule}: P1 violated — ${t.from} → ${t.to}`).toBe(true);
      expect(checkRestartLegality(t.from, t.to),
        `${t.rule}: P2 violated — ${t.from} → ${t.to}`).toBe(true);
      expect(checkUpdateLegality(t.from, t.to),
        `${t.rule}: P3 violated — ${t.from} → ${t.to}`).toBe(true);
    }
  });

  it('every Podman transition respects P1', () => {
    for (const t of PODMAN_TRANSITIONS) {
      expect(checkNoResurrection(t.from, t.to),
        `${t.rule}: P1 violated — ${t.from} → ${t.to}`).toBe(true);
    }
  });

  it('no transition originates from a terminal state', () => {
    for (const t of ALL_TRANSITIONS) {
      expect(isTerminal(t.from),
        `${t.rule}: originates from terminal state ${t.from}`).toBe(false);
    }
  });
});

// ─── 16. ContainerStateValue enumeration ───

describe('ContainerStateValue', () => {
  it('has exactly 3 values (§1.3)', () => {
    expect(Object.values(ContainerStateValue)).toHaveLength(3);
    expect(ContainerStateValue.Waiting).toBe('Waiting');
    expect(ContainerStateValue.Running).toBe('Running');
    expect(ContainerStateValue.Terminated).toBe('Terminated');
  });
});
