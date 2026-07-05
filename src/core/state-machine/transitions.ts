/**
 * Compile-time transition tables for all status enums and type unions.
 *
 * Each table is checked via `assertExhaustive<Status>(table)`.
 * Add a new status value → tsc error:
 *   TS2741: Property 'NewValue' is missing in type '...'
 */

import type { ExhaustiveTransitions } from './types.ts';

/** Assert at compile time that `table` covers every key in `S`. */
function assertExhaustive<S extends string>(_table: ExhaustiveTransitions<S>): void { /* compile-time check only */ }

// ═══════════════ enum-based statuses ═══════════════

import { VolumeStatus } from '../volume/types.ts';
const _V = {
  [VolumeStatus.Detached]: [VolumeStatus.Attached],
  [VolumeStatus.Attached]: [VolumeStatus.Detached, VolumeStatus.Orphaned],
  [VolumeStatus.Orphaned]: ([] satisfies readonly VolumeStatus[]),
} as const satisfies Record<VolumeStatus, readonly VolumeStatus[]>;
assertExhaustive<VolumeStatus>(_V);

enum ContainerStatus {
  Waiting = 'Waiting',
  Running = 'Running',
  Terminated = 'Terminated',
}

const _C = {
  [ContainerStatus.Waiting]: [ContainerStatus.Running, ContainerStatus.Terminated],
  [ContainerStatus.Running]: [ContainerStatus.Terminated],
  [ContainerStatus.Terminated]: [] satisfies readonly ContainerStatus[],
} as const satisfies Record<ContainerStatus, readonly ContainerStatus[]>;
assertExhaustive<ContainerStatus>(_C);

import { DnsRecordStatus } from '../../features/dns/types.ts';
const _D = {
  [DnsRecordStatus.Active]: [DnsRecordStatus.Stale],
  [DnsRecordStatus.Stale]: [DnsRecordStatus.Active],
} as const satisfies Record<DnsRecordStatus, readonly DnsRecordStatus[]>;
assertExhaustive<DnsRecordStatus>(_D);

// ═══════════════ type-union statuses (string literals used directly) ═══════════════

import type { SecurityGroupStatus } from '../../features/network/types.ts';
const _SG = {
  Active: ['Inactive', 'Error'],
  Inactive: ['Active', 'Error'],
  Error: ['Active'],
} as const satisfies Record<SecurityGroupStatus, readonly SecurityGroupStatus[]>;
assertExhaustive<SecurityGroupStatus>(_SG);

import type { SubnetStatus } from '../../features/subnet/types.ts';
const _SN = {
  Active: ['Inactive', 'Full', 'Error'],
  Inactive: ['Active', 'Error'],
  Full: ['Inactive', 'Error'],
  Error: ['Active'],
} as const satisfies Record<SubnetStatus, readonly SubnetStatus[]>;
assertExhaustive<SubnetStatus>(_SN);

import type { InstanceStatus } from '../../core/region/instance.ts';
const _I = {
  online: ['offline', 'error'],
  offline: ['online', 'error'],
  error: ['online', 'offline'],
} as const satisfies Record<InstanceStatus, readonly InstanceStatus[]>;
assertExhaustive<InstanceStatus>(_I);

import type { InviteStatus } from '../../features/permission/types.ts';
const _IV = {
  pending: ['accepted', 'rejected'],
  accepted: [] satisfies readonly InviteStatus[],
  rejected: [] satisfies readonly InviteStatus[],
} as const satisfies Record<InviteStatus, readonly InviteStatus[]>;
assertExhaustive<InviteStatus>(_IV);

import type { ApprovalStatus } from '../../features/actions/extensions.ts';
const _AP = {
  pending: ['approved', 'rejected'],
  approved: [] satisfies readonly ApprovalStatus[],
  rejected: [] satisfies readonly ApprovalStatus[],
} as const satisfies Record<ApprovalStatus, readonly ApprovalStatus[]>;
assertExhaustive<ApprovalStatus>(_AP);

// ═══════════════ Carry-over from prior work (string-union types) ═══════════════
// These were already validated in the previous iteration — kept for completeness.

import type { WorkflowRunStatus, JobRunStatus } from '../../features/actions/types.ts';
import type { DagRunStatus } from '../dag/types.ts';
import type { RunnerStatus } from '../../features/instances/types.ts';

const _W = {
  Pending: ['Running', 'Cancelled'],
  Running: ['Success', 'Failure', 'Cancelled', 'TimedOut'],
  Success: [] satisfies readonly WorkflowRunStatus[],
  Failure: [] satisfies readonly WorkflowRunStatus[],
  Cancelled: [] satisfies readonly WorkflowRunStatus[],
  TimedOut: [] satisfies readonly WorkflowRunStatus[],
} as const satisfies Record<WorkflowRunStatus, readonly WorkflowRunStatus[]>;
assertExhaustive<WorkflowRunStatus>(_W);

const _J = {
  Queued: ['Running', 'Skipped', 'Cancelled'],
  Running: ['Success', 'Failure', 'Cancelled'],
  Success: [] satisfies readonly JobRunStatus[],
  Failure: [] satisfies readonly JobRunStatus[],
  Skipped: [] satisfies readonly JobRunStatus[],
  Cancelled: [] satisfies readonly JobRunStatus[],
} as const satisfies Record<JobRunStatus, readonly JobRunStatus[]>;
assertExhaustive<JobRunStatus>(_J);

const _DG = {
  QUEUED: ['RUNNING', 'FAILED'],
  RUNNING: ['SUCCESS', 'FAILED'],
  SUCCESS: [] satisfies readonly DagRunStatus[],
  FAILED: [] satisfies readonly DagRunStatus[],
} as const satisfies Record<DagRunStatus, readonly DagRunStatus[]>;
assertExhaustive<DagRunStatus>(_DG);

const _R = {
  online: ['offline'],
  offline: ['online'],
} as const satisfies Record<RunnerStatus, readonly RunnerStatus[]>;
assertExhaustive<RunnerStatus>(_R);
