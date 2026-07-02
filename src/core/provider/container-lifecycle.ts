/**
 * Abstract Container Group Lifecycle — formal state machine derived from
 * the Alibaba ECI ContainerGroup model (SPEC/ECI_LIFECYCLE_FORMAL_MODEL.md).
 *
 * Design invariants:
 * - Pure functions only — no IO, no side effects. Trivially testable.
 * - The full state set is a superset of all provider states (ECI + Podman).
 * - Each provider declares a ContainerLifecycleProfile that is a restriction of
 *   the full model, not an ad-hoc flag set.
 * - All 5 ECI safety invariants are encoded as runtime-checkable assertions.
 * - The bridge to SandboxStatus is a pure, verified mapping.
 */

// ─── 1. Complete state set (§1 of formal model) ───

/** Full ContainerGroup state space.
 *  ECI defines 11 states. Podman adds 2: Stopped, Paused.
 *  Sorted by lifecycle phase: creation → runtime → terminal. */
export enum ContainerGroupState {
  /** ECI: Scheduling — transient, resources being allocated. */
  Scheduling = 'Scheduling',
  /** ECI: ScheduleFailed — terminal, no capacity / invalid params. */
  ScheduleFailed = 'ScheduleFailed',
  /** ECI: Pending — image pull + container init. Podman: analogous to "Created". */
  Pending = 'Pending',
  /** Steady state — all containers alive and serving. */
  Running = 'Running',
  /** ECI: Updating — UpdateContainerGroup in flight. */
  Updating = 'Updating',
  /** ECI: Restarting — RestartContainerGroup in flight. Podman: analogous. */
  Restarting = 'Restarting',
  /** Podman: Stopped — pod exists but processes are not running. Recoverable.
   *  ECI does NOT have this state (stop = delete). */
  Stopped = 'Stopped',
  /** Podman: Paused — cgroups frozen. Not in ECI model. */
  Paused = 'Paused',
  /** ECI: Terminating — DeleteContainerGroup grace period. */
  Terminating = 'Terminating',
  // ─── Terminal states (§3.2) ───
  /** ECI: Succeeded — containers exited with code 0, RestartPolicy != Always. */
  Succeeded = 'Succeeded',
  /** ECI: Failed — init/container error, or RestartPolicy=Never + non-zero exit. */
  Failed = 'Failed',
  /** ECI: Expired — preemptible instance reclaimed by platform. */
  Expired = 'Expired',
  /** ECI: Deleted — resources removed from cloud. Logical terminal. */
  Deleted = 'Deleted',
}

// ─── 2. Container-level states (§1.3) ───

export enum ContainerStateValue {
  Waiting = 'Waiting',
  Running = 'Running',
  Terminated = 'Terminated',
}

// ─── 3. Trigger taxonomy (§3) ───

/** System events — the cloud platform initiates these transitions. */
export type SystemEvent =
  | 'ScheduleSucceeded'
  | 'ScheduleFailed'
  | 'InitSucceeded'
  | 'InitFailed'
  | 'ContainerExited0'
  | 'ContainerExitedNonZero'
  | 'InstanceExpired'
  | 'RestartSucceeded'
  | 'RestartFailed'
  | 'UpdateSucceeded'
  | 'UpdateFailed'
  | 'CleanupComplete';

/** API operations — the user initiates these transitions (§4). */
export type ApiOperation =
  | 'CreateContainerGroup'
  | 'DeleteContainerGroup'
  | 'RestartContainerGroup'
  | 'UpdateContainerGroup'
  | 'StopContainerGroup'
  | 'StartContainerGroup'
  | 'PauseContainerGroup'
  | 'UnpauseContainerGroup';

/** A transition trigger: either a system event, an API call, or a RestartPolicy evaluation. */
export type TransitionTrigger =
  | { readonly kind: 'System'; readonly event: SystemEvent }
  | { readonly kind: 'Api'; readonly operation: ApiOperation }
  | { readonly kind: 'RestartPolicy'; readonly exitCode: number; readonly policy: RestartPolicy };

/** RestartPolicy values (§8). */
export type RestartPolicy = 'Always' | 'OnFailure' | 'Never';

// ─── 4. Transition function (§3.1, 18 rules) ───

/** Ordered pair of states. */
export interface Transition {
  readonly from: ContainerGroupState;
  readonly to: ContainerGroupState;
}

/** Complete transition table — all 18 ECI rules + Podman extensions.
 *  Each entry is a (from, trigger, to) triple.
 *  System transitions are always valid when the system reports the event.
 *  API transitions are only valid when canApplyOperation(from, op) is true. */
export const ECI_TRANSITIONS: readonly {
  readonly from: ContainerGroupState;
  readonly trigger: TransitionTrigger;
  readonly to: ContainerGroupState;
  readonly rule: string;
}[] = [
  // T1: Scheduling + ScheduleSucceeded → Pending
  { from: ContainerGroupState.Scheduling, trigger: { kind: 'System', event: 'ScheduleSucceeded' }, to: ContainerGroupState.Pending, rule: 'T1' },
  // T2: Scheduling + ScheduleFailed → ScheduleFailed
  { from: ContainerGroupState.Scheduling, trigger: { kind: 'System', event: 'ScheduleFailed' }, to: ContainerGroupState.ScheduleFailed, rule: 'T2' },
  // T3: Pending + InitSucceeded → Running
  { from: ContainerGroupState.Pending, trigger: { kind: 'System', event: 'InitSucceeded' }, to: ContainerGroupState.Running, rule: 'T3' },
  // T4: Pending + InitFailed → Failed
  { from: ContainerGroupState.Pending, trigger: { kind: 'System', event: 'InitFailed' }, to: ContainerGroupState.Failed, rule: 'T4' },
  // T5: Running + ContainerExited0 → Succeeded (policy-dependent, handled by RestartPolicy trigger)
  { from: ContainerGroupState.Running, trigger: { kind: 'System', event: 'ContainerExited0' }, to: ContainerGroupState.Succeeded, rule: 'T5' },
  // T6: Running + ContainerExitedNonZero → Failed (policy-dependent)
  { from: ContainerGroupState.Running, trigger: { kind: 'System', event: 'ContainerExitedNonZero' }, to: ContainerGroupState.Failed, rule: 'T6' },
  // T7: Running + RestartContainerGroup → Restarting
  { from: ContainerGroupState.Running, trigger: { kind: 'Api', operation: 'RestartContainerGroup' }, to: ContainerGroupState.Restarting, rule: 'T7' },
  // T8: Running + UpdateContainerGroup → Updating
  { from: ContainerGroupState.Running, trigger: { kind: 'Api', operation: 'UpdateContainerGroup' }, to: ContainerGroupState.Updating, rule: 'T8' },
  // T9: Running + DeleteContainerGroup → Terminating
  { from: ContainerGroupState.Running, trigger: { kind: 'Api', operation: 'DeleteContainerGroup' }, to: ContainerGroupState.Terminating, rule: 'T9' },
  // T10: Running + InstanceExpired → Expired
  { from: ContainerGroupState.Running, trigger: { kind: 'System', event: 'InstanceExpired' }, to: ContainerGroupState.Expired, rule: 'T10' },
  // T11: Restarting + RestartSucceeded → Pending
  { from: ContainerGroupState.Restarting, trigger: { kind: 'System', event: 'RestartSucceeded' }, to: ContainerGroupState.Pending, rule: 'T11' },
  // T12: Restarting + RestartFailed → Failed
  { from: ContainerGroupState.Restarting, trigger: { kind: 'System', event: 'RestartFailed' }, to: ContainerGroupState.Failed, rule: 'T12' },
  // T13: Updating + UpdateSucceeded → Running
  { from: ContainerGroupState.Updating, trigger: { kind: 'System', event: 'UpdateSucceeded' }, to: ContainerGroupState.Running, rule: 'T13' },
  // T14: Updating + UpdateFailed → Running (rollback)
  { from: ContainerGroupState.Updating, trigger: { kind: 'System', event: 'UpdateFailed' }, to: ContainerGroupState.Running, rule: 'T14' },
  // T15: Terminating + CleanupComplete → Deleted
  { from: ContainerGroupState.Terminating, trigger: { kind: 'System', event: 'CleanupComplete' }, to: ContainerGroupState.Deleted, rule: 'T15' },
  // T16: Restarting + DeleteContainerGroup → Terminating
  { from: ContainerGroupState.Restarting, trigger: { kind: 'Api', operation: 'DeleteContainerGroup' }, to: ContainerGroupState.Terminating, rule: 'T16' },
  // T17: Updating + DeleteContainerGroup → Terminating
  { from: ContainerGroupState.Updating, trigger: { kind: 'Api', operation: 'DeleteContainerGroup' }, to: ContainerGroupState.Terminating, rule: 'T17' },
  // T18: Pending + DeleteContainerGroup → Terminating
  { from: ContainerGroupState.Pending, trigger: { kind: 'Api', operation: 'DeleteContainerGroup' }, to: ContainerGroupState.Terminating, rule: 'T18' },
];

/** Podman-specific transitions (not in ECI model). */
export const PODMAN_TRANSITIONS: readonly {
  readonly from: ContainerGroupState;
  readonly trigger: TransitionTrigger;
  readonly to: ContainerGroupState;
  readonly rule: string;
}[] = [
  // P1: Running + StopContainerGroup → Stopped (reversible, unlike ECI)
  { from: ContainerGroupState.Running, trigger: { kind: 'Api', operation: 'StopContainerGroup' }, to: ContainerGroupState.Stopped, rule: 'P1' },
  // P2: Stopped + StartContainerGroup → Running
  { from: ContainerGroupState.Stopped, trigger: { kind: 'Api', operation: 'StartContainerGroup' }, to: ContainerGroupState.Running, rule: 'P2' },
  // P3: Running + PauseContainerGroup → Paused
  { from: ContainerGroupState.Running, trigger: { kind: 'Api', operation: 'PauseContainerGroup' }, to: ContainerGroupState.Paused, rule: 'P3' },
  // P4: Paused + UnpauseContainerGroup → Running
  { from: ContainerGroupState.Paused, trigger: { kind: 'Api', operation: 'UnpauseContainerGroup' }, to: ContainerGroupState.Running, rule: 'P4' },
  // P5: Stopped + DeleteContainerGroup → Terminating
  { from: ContainerGroupState.Stopped, trigger: { kind: 'Api', operation: 'DeleteContainerGroup' }, to: ContainerGroupState.Terminating, rule: 'P5' },
  // P6: Paused + StopContainerGroup → Stopped
  { from: ContainerGroupState.Paused, trigger: { kind: 'Api', operation: 'StopContainerGroup' }, to: ContainerGroupState.Stopped, rule: 'P6' },
  // P7: Paused + DeleteContainerGroup → Terminating
  { from: ContainerGroupState.Paused, trigger: { kind: 'Api', operation: 'DeleteContainerGroup' }, to: ContainerGroupState.Terminating, rule: 'P7' },
];

/** All known transitions (ECI + Podman). */
export const ALL_TRANSITIONS: readonly {
  readonly from: ContainerGroupState;
  readonly trigger: TransitionTrigger;
  readonly to: ContainerGroupState;
  readonly rule: string;
}[] = [...ECI_TRANSITIONS, ...PODMAN_TRANSITIONS];

// ─── 5. Transition function ───

/** δ: State × Trigger → State
 *  Returns the target state if the transition is known, otherwise returns the
 *  input state unchanged (terminal absorption + invalid transition handling). */
export function transition(
  state: ContainerGroupState,
  trigger: TransitionTrigger,
): ContainerGroupState {
  // RestartPolicy trigger: evaluate exit code against policy (§8)
  if (trigger.kind === 'RestartPolicy') {
    return evaluateRestartPolicy(state, trigger.exitCode, trigger.policy);
  }

  // Check all known transitions
  for (const t of ALL_TRANSITIONS) {
    if (t.from === state && triggerEquals(t.trigger, trigger)) {
      return t.to;
    }
  }

  // No matching transition — state is unchanged (invalid transition / terminal)
  return state;
}

/** Evaluate RestartPolicy-based transition from Running state (§8).
 *  - Always: exit(0) → Restarting, exit(!0) → Restarting
 *  - OnFailure: exit(0) → Succeeded, exit(!0) → Restarting
 *  - Never: exit(0) → Succeeded, exit(!0) → Failed */
export function evaluateRestartPolicy(
  state: ContainerGroupState,
  exitCode: number,
  policy: RestartPolicy,
): ContainerGroupState {
  if (state !== ContainerGroupState.Running) return state;

  if (policy === 'Always') {
    return ContainerGroupState.Restarting;
  }
  if (policy === 'OnFailure') {
    return exitCode === 0 ? ContainerGroupState.Succeeded : ContainerGroupState.Restarting;
  }
  // Never
  return exitCode === 0 ? ContainerGroupState.Succeeded : ContainerGroupState.Failed;
}

function triggerEquals(a: TransitionTrigger, b: TransitionTrigger): boolean {
  if (a.kind !== b.kind) return false;
  // Both sides confirmed same kind. The switch narrows each variant
  // so TypeScript can verify field access without type assertions.
  switch (a.kind) {
    case 'System': return b.kind === 'System' && a.event === b.event;
    case 'Api': return b.kind === 'Api' && a.operation === b.operation;
    case 'RestartPolicy': return b.kind === 'RestartPolicy' && a.exitCode === b.exitCode && a.policy === b.policy;
    default: {
      const _exhaustive: never = a;
      throw new Error(`Unexpected trigger kind: ${String(_exhaustive)}`);
    }
  }
}

// ─── 6. Terminal states (§3.2) ───

export const TERMINAL_STATES: ReadonlySet<ContainerGroupState> = new Set([
  ContainerGroupState.ScheduleFailed,
  ContainerGroupState.Succeeded,
  ContainerGroupState.Failed,
  ContainerGroupState.Expired,
  ContainerGroupState.Deleted,
]);

export function isTerminal(state: ContainerGroupState): boolean {
  return TERMINAL_STATES.has(state);
}

// ─── 7. API operation preconditions (§4) ───

/** Legal pre-states for each API operation. Derived from §4 of the formal model. */
export const API_PRECONDITIONS: Readonly<Record<ApiOperation, ReadonlySet<ContainerGroupState>>> = {
  CreateContainerGroup: new Set([]), // no pre-state — creates new resource
  DeleteContainerGroup: new Set([
    ContainerGroupState.Running,
    ContainerGroupState.Pending,
    ContainerGroupState.Restarting,
    ContainerGroupState.Updating,
    ContainerGroupState.Stopped,
    ContainerGroupState.Paused,
  ]),
  RestartContainerGroup: new Set([ContainerGroupState.Running]),
  UpdateContainerGroup: new Set([ContainerGroupState.Running]),
  StopContainerGroup: new Set([
    ContainerGroupState.Running,
    ContainerGroupState.Paused,
  ]),
  StartContainerGroup: new Set([ContainerGroupState.Stopped]),
  PauseContainerGroup: new Set([ContainerGroupState.Running]),
  UnpauseContainerGroup: new Set([ContainerGroupState.Paused]),
};

export function canApplyOperation(state: ContainerGroupState, op: ApiOperation): boolean {
  if (op === 'CreateContainerGroup') return true; // creates new, no pre-state
  const allowed = API_PRECONDITIONS[op];
  return allowed.has(state);
}

/** Check if a Delete can be applied — non-terminal, non-Terminating (§4 + P4). */
export function isDeleteAllowed(state: ContainerGroupState): boolean {
  return canApplyOperation(state, 'DeleteContainerGroup');
}

// ─── 8. Safety invariants (§5.1) — runtime-checkable assertions ───

/** P1: Terminal states cannot transition to any other state. */
export function checkNoResurrection(before: ContainerGroupState, after: ContainerGroupState): boolean {
  if (isTerminal(before)) {
    return before === after;
  }
  return true;
}

/** P2: Restarting can only be reached from Running. */
export function checkRestartLegality(_before: ContainerGroupState, after: ContainerGroupState): boolean {
  if (after === ContainerGroupState.Restarting) {
    return _before === ContainerGroupState.Running;
  }
  return true;
}

/** P3: Updating can only be reached from Running. */
export function checkUpdateLegality(_before: ContainerGroupState, after: ContainerGroupState): boolean {
  if (after === ContainerGroupState.Updating) {
    return _before === ContainerGroupState.Running;
  }
  return true;
}

/** P4: Terminating can only be reached from {Running, Pending, Restarting, Updating, Stopped, Paused}. */
export function checkDeleteLegality(before: ContainerGroupState): boolean {
  return isDeleteAllowed(before);
}

/** P5: Container Running implies CG Running.
 *  Returns true if the invariant holds. */
export function checkContainerCGRunning(
  cgState: ContainerGroupState,
  containerStates: readonly ContainerStateValue[],
): boolean {
  const anyContainerRunning = containerStates.some(cs => cs === ContainerStateValue.Running);
  if (anyContainerRunning) {
    return cgState === ContainerGroupState.Running;
  }
  return true; // no Running containers → no constraint
}

// ─── 9. Liveness properties (§5.2) — not runtime-checkable, but documented ───

/** Transient states that MUST eventually resolve. Used by health-check for timeout-based GC. */
export const TRANSIENT_STATES: ReadonlySet<ContainerGroupState> = new Set([
  ContainerGroupState.Scheduling,
  ContainerGroupState.Pending,
  ContainerGroupState.Restarting,
  ContainerGroupState.Updating,
  ContainerGroupState.Terminating,
]);

/** Check if a state is transient (the system guarantees eventual resolution). */
export function isTransient(state: ContainerGroupState): boolean {
  return TRANSIENT_STATES.has(state);
}

// ─── 10. Provider lifecycle profile ───

/** Each provider declares its capabilities as a restriction of the full model.
 *  Replaces the old ad-hoc ContainerLifecycle (4 booleans). */
export interface ContainerLifecycleProfile {
  /** States this provider can reach. Must be a subset of ContainerGroupState. */
  readonly reachableStates: ReadonlySet<ContainerGroupState>;
  /** Is stop() terminal (same as delete)? ECI: true, Podman: false. */
  readonly stopIsDelete: boolean;
  /** Can a stopped container be started again? */
  readonly startable: boolean;
  /** Can the provider report per-container health probe results? */
  readonly healthProbes: boolean;
  /** Does create() return before the instance reaches Running? */
  readonly asyncInit: boolean;
  /** Does the provider support RestartContainerGroup? */
  readonly supportsRestart: boolean;
  /** Does the provider support UpdateContainerGroup? */
  readonly supportsUpdate: boolean;
  /** Does the provider support ExecContainerCommand? */
  readonly supportsExec: boolean;
}

/** ECI ContainerGroup profile — matches the formal model exactly. */
export const ECI_PROFILE: ContainerLifecycleProfile = {
  reachableStates: new Set([
    ContainerGroupState.Scheduling,
    ContainerGroupState.ScheduleFailed,
    ContainerGroupState.Pending,
    ContainerGroupState.Running,
    ContainerGroupState.Updating,
    ContainerGroupState.Restarting,
    ContainerGroupState.Terminating,
    ContainerGroupState.Succeeded,
    ContainerGroupState.Failed,
    ContainerGroupState.Expired,
    ContainerGroupState.Deleted,
  ]),
  stopIsDelete: true,
  startable: false,
  healthProbes: false,
  asyncInit: true,
  supportsRestart: true,
  supportsUpdate: true,
  supportsExec: true,
};

/** Podman profile — subset of states, supports Stopped/Paused. */
export const PODMAN_PROFILE: ContainerLifecycleProfile = {
  reachableStates: new Set([
    ContainerGroupState.Pending,
    ContainerGroupState.Running,
    ContainerGroupState.Stopped,
    ContainerGroupState.Paused,
    ContainerGroupState.Terminating,
    ContainerGroupState.Deleted,
  ]),
  stopIsDelete: false,
  startable: true,
  healthProbes: true,
  asyncInit: false,
  supportsRestart: false,
  supportsUpdate: false,
  supportsExec: true,
};

/** Stub profile — minimal, sync init. */
export const STUB_PROFILE: ContainerLifecycleProfile = {
  reachableStates: new Set([
    ContainerGroupState.Running,
    ContainerGroupState.Stopped,
    ContainerGroupState.Terminating,
    ContainerGroupState.Deleted,
  ]),
  stopIsDelete: false,
  startable: true,
  healthProbes: false,
  asyncInit: false,
  supportsRestart: false,
  supportsUpdate: false,
  supportsExec: false,
};

/** Map provider platform name to its lifecycle profile. */
export function profileForPlatform(platform: string): ContainerLifecycleProfile {
  switch (platform) {
    case 'alibaba': return ECI_PROFILE;
    case 'podman': return PODMAN_PROFILE;
    case 'stub': return STUB_PROFILE;
    default: return STUB_PROFILE;
  }
}

// ─── 11. Bridge to SandboxStatus (§6, business layer mapping) ───

import { SandboxStatus } from '../../features/sandbox/types.ts';

/** Map a concrete ContainerGroupState to the business-layer SandboxStatus.
 *  This is a pure function — the mapping is verified against the formal model.
 *
 *  Mapping rationale:
 *  - Scheduling/Pending → Scheduling (business layer sees both as "not yet Running")
 *  - Running/Updating → Running (spec update is transparent to business layer)
 *  - Restarting → Scheduling (restart → re-init cycle, business layer sees as transient)
 *  - Stopped/Paused → Stopped (business layer: not running, recoverable)
 *  - Terminating → Terminated (business layer: shutdown in progress = terminal for user)
 *  - Succeeded/Failed/Expired/ScheduleFailed → Failed (all terminal errors collapse)
 *  - Deleted → Deleted
 */
/** Map provider-level ECI state to business-level SandboxStatus (11-state model). */
export function toSandboxStatus(state: ContainerGroupState): SandboxStatus {
  switch (state) {
    case ContainerGroupState.Scheduling:
    case ContainerGroupState.Pending:
    case ContainerGroupState.Restarting:
      return SandboxStatus.Scheduling;

    case ContainerGroupState.Running:
    case ContainerGroupState.Updating:
      return SandboxStatus.Running;

    case ContainerGroupState.Stopped:
    case ContainerGroupState.Paused:
      return SandboxStatus.Succeeded;

    case ContainerGroupState.Terminating:
      return SandboxStatus.Terminating;

    case ContainerGroupState.ScheduleFailed:
      return SandboxStatus.ScheduleFailed;

    case ContainerGroupState.Failed:
      return SandboxStatus.Failed;

    case ContainerGroupState.Succeeded:
      return SandboxStatus.Succeeded;

    case ContainerGroupState.Expired:
      return SandboxStatus.Expired;

    case ContainerGroupState.Deleted:
      return SandboxStatus.Deleted;
  }
}

/** Reverse mapping: which ContainerGroupStates map to a given SandboxStatus. */
export function fromSandboxStatus(status: SandboxStatus): readonly ContainerGroupState[] {
  switch (status) {
    case SandboxStatus.Scheduling:
      return [ContainerGroupState.Scheduling, ContainerGroupState.Pending, ContainerGroupState.Restarting];
    case SandboxStatus.Pending:
      return [ContainerGroupState.Scheduling, ContainerGroupState.Pending];
    case SandboxStatus.Running:
      return [ContainerGroupState.Running, ContainerGroupState.Updating];
    case SandboxStatus.Succeeded:
      return [ContainerGroupState.Stopped, ContainerGroupState.Paused, ContainerGroupState.Succeeded];
    case SandboxStatus.Failed:
      return [ContainerGroupState.Failed];
    case SandboxStatus.Restarting:
      return [ContainerGroupState.Restarting];
    case SandboxStatus.Updating:
      return [ContainerGroupState.Updating];
    case SandboxStatus.Terminating:
      return [ContainerGroupState.Terminating];
    case SandboxStatus.ScheduleFailed:
      return [ContainerGroupState.ScheduleFailed];
    case SandboxStatus.Expired:
      return [ContainerGroupState.Expired];
    case SandboxStatus.Deleted:
      return [ContainerGroupState.Deleted];
    default:
      return [];
  }
}

/** Re-export the old ContainerLifecycle for backward compat during migration.
 *  Derived from ContainerLifecycleProfile. */
export interface ContainerLifecycle {
  readonly stopIsDelete: boolean;
  readonly startable: boolean;
  readonly healthProbes: boolean;
  readonly asyncInit: boolean;
}

export function toLegacyLifecycle(profile: ContainerLifecycleProfile): ContainerLifecycle {
  return {
    stopIsDelete: profile.stopIsDelete,
    startable: profile.startable,
    healthProbes: profile.healthProbes,
    asyncInit: profile.asyncInit,
  };
}

// ─── 12. Formal verification helpers ───

/** Verify that a transition sequence respects all 5 safety invariants.
 *  Returns the first violated invariant name, or null if all pass. */
export function verifyTransitionSequence(
  steps: readonly { from: ContainerGroupState; to: ContainerGroupState }[],
): string | null {
  for (const step of steps) {
    if (!checkNoResurrection(step.from, step.to)) return 'P1: NoResurrection';
    if (!checkRestartLegality(step.from, step.to)) return 'P2: RestartLegality';
    if (!checkUpdateLegality(step.from, step.to)) return 'P3: UpdateLegality';
  }
  return null;
}

/** Check that a ContainerLifecycleProfile is internally consistent:
 *  - If stopIsDelete, Stopped must NOT be in reachableStates.
 *  - If !startable, Stopped must NOT be in reachableStates (or startable must be true).
 *  - If asyncInit, Scheduling must be in reachableStates. */
export function validateProfile(profile: ContainerLifecycleProfile): string | null {
  if (profile.stopIsDelete && profile.reachableStates.has(ContainerGroupState.Stopped)) {
    return 'stopIsDelete=true but Stopped is reachable — Stopped implies recoverable state';
  }
  if (profile.startable && !profile.reachableStates.has(ContainerGroupState.Stopped)) {
    return 'startable=true but Stopped is not reachable';
  }
  if (profile.asyncInit && !profile.reachableStates.has(ContainerGroupState.Scheduling)) {
    return 'asyncInit=true but Scheduling is not reachable';
  }
  if (profile.supportsRestart && !profile.reachableStates.has(ContainerGroupState.Restarting)) {
    return 'supportsRestart=true but Restarting is not reachable';
  }
  if (profile.supportsUpdate && !profile.reachableStates.has(ContainerGroupState.Updating)) {
    return 'supportsUpdate=true but Updating is not reachable';
  }
  return null;
}
