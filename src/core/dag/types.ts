import { z } from 'zod';
import type { VersionId } from '../brand.ts';

const dagIdSchema = z.string().min(1).brand('DagId');
const dagRunIdSchema = z.string().min(1).brand('DagRunId');
const taskIdSchema = z.string().min(1).brand('TaskId');
const taskInstanceIdSchema = z.string().min(1).brand('TaskInstanceId');

export type DagId = z.infer<typeof dagIdSchema>;
export type DagRunId = z.infer<typeof dagRunIdSchema>;
export type TaskId = z.infer<typeof taskIdSchema>;
export type TaskInstanceId = z.infer<typeof taskInstanceIdSchema>;

export function createDagId(raw: string): DagId { return dagIdSchema.parse(raw); }
export function createDagRunId(raw: string): DagRunId { return dagRunIdSchema.parse(raw); }
export function createTaskId(raw: string): TaskId { return taskIdSchema.parse(raw); }
export function createTaskInstanceId(raw: string): TaskInstanceId { return taskInstanceIdSchema.parse(raw); }
// ─── Trigger rule (Airflow 9) ───

export type TriggerRule =
  | 'all_success'
  | 'all_failed'
  | 'all_done'
  | 'one_success'
  | 'one_failed'
  | 'none_failed'
  | 'none_skipped'
  | 'none_failed_min_one_success'
  | 'always';

export const DEFAULT_TRIGGER_RULE: TriggerRule = 'all_success';

// ─── Operator type (extensible) ───

export type OperatorType =
  | 'run'              // shell command inside container
  | 'uses'             // reusable action reference (container image or JS)
  | 'dns'              // DNS record upsert/delete
  | 'pod'              // provision a full container group
  | 'approval-sensor'  // approval gate — waits for manual approve/reject
  | 'noop';            // no-op (placeholder / passthrough)

// ─── Task definition ───

export interface Task {
  readonly id: TaskId;
  readonly name: string;
  readonly operatorType: OperatorType;
  /** Operator-specific configuration (arbitrary JSON). */
  readonly config: Record<string, unknown>;
  /** Task IDs this task depends on (upstream edges). */
  readonly dependsOn: readonly TaskId[];
  readonly triggerRule: TriggerRule;
  readonly retries: number;
  readonly retryDelayMs: number;
  readonly timeoutMs?: number;
  /** Pool name for slot-based concurrency. */
  readonly pool?: string;
  /** Priority within the pool (higher = more important). */
  readonly priorityWeight?: number;
  /** Maximum active TaskInstances for this task across all DagRuns. */
  readonly maxActiveTisPerDag?: number;
  /** Target compute instance / runner label. */
  readonly executorKey?: string;
  /** Arbitrary metadata for extensions. */
  readonly metadata?: Record<string, unknown>;
}

// ─── TaskInstance state machine ───

/**
 * Unified 12-state machine merging Airflow 13 + GHA 6.
 *
 *   NONE → SCHEDULED → QUEUED → RUNNING → SUCCESS | FAILED
 *                                        ├── UP_FOR_RETRY → (back to QUEUED)
 *                                        ├── DEFERRED     → (back to SCHEDULED)
 *                                        └── RESTARTING   → (back to QUEUED)
 *   SCHEDULED → SKIPPED | UPSTREAM_FAILED
 *   Any non-terminal state → REMOVED
 */
export type TaskInstanceState =
  | 'NONE'
  | 'SCHEDULED'
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCESS'
  | 'FAILED'
  | 'UP_FOR_RETRY'
  | 'SKIPPED'
  | 'UPSTREAM_FAILED'
  | 'DEFERRED'
  | 'RESTARTING'
  | 'REMOVED';

export const TERMINAL_TASK_STATES: ReadonlySet<TaskInstanceState> = new Set([
  'SUCCESS', 'FAILED', 'SKIPPED', 'UPSTREAM_FAILED', 'REMOVED',
]);

export function isTaskTerminal(state: TaskInstanceState): boolean {
  return TERMINAL_TASK_STATES.has(state);
}

export const TASK_VALID_TRANSITIONS: Readonly<Record<TaskInstanceState, readonly TaskInstanceState[]>> = {
  NONE:              ['SCHEDULED', 'SKIPPED', 'UPSTREAM_FAILED', 'REMOVED'],
  SCHEDULED:         ['QUEUED', 'SKIPPED', 'UPSTREAM_FAILED', 'REMOVED'],
  QUEUED:            ['RUNNING', 'REMOVED'],
  RUNNING:           ['SUCCESS', 'FAILED', 'UP_FOR_RETRY', 'DEFERRED', 'RESTARTING', 'REMOVED'],
  UP_FOR_RETRY:      ['QUEUED', 'FAILED'],
  DEFERRED:          ['SCHEDULED', 'REMOVED'],
  RESTARTING:        ['QUEUED', 'REMOVED'],
  SUCCESS:           [],
  FAILED:            [],
  SKIPPED:           [],
  UPSTREAM_FAILED:   [],
  REMOVED:           [],
};

export function isValidTaskTransition(from: TaskInstanceState, to: TaskInstanceState): boolean {
  return TASK_VALID_TRANSITIONS[from].includes(to);
}

// ─── ContainerGroup (execution carrier) ───

export type ContainerGroupState =
  | 'Scheduling'
  | 'ScheduleFailed'
  | 'Pending'
  | 'Running'
  | 'Succeeded'
  | 'Failed'
  | 'Restarting'
  | 'Updating'
  | 'Terminating'
  | 'Expired'
  | 'Deleted';

export const CG_HARD_TERMINAL: ReadonlySet<ContainerGroupState> = new Set(['ScheduleFailed', 'Expired', 'Deleted']);
export const CG_SOFT_TERMINAL: ReadonlySet<ContainerGroupState> = new Set(['Succeeded', 'Failed']);

export function isCgTerminal(state: ContainerGroupState): boolean {
  return CG_HARD_TERMINAL.has(state) || CG_SOFT_TERMINAL.has(state);
}

export const CG_VALID_TRANSITIONS: Readonly<Record<ContainerGroupState, readonly ContainerGroupState[]>> = {
  Scheduling:     ['Pending', 'ScheduleFailed'],
  ScheduleFailed: ['Deleted'],
  Pending:        ['Running', 'Failed', 'Terminating'],
  Running:        ['Succeeded', 'Failed', 'Restarting', 'Updating', 'Terminating', 'Expired'],
  Succeeded:      ['Running', 'Terminating'],
  Failed:         ['Running', 'Terminating'],
  Restarting:     ['Pending', 'Failed', 'Terminating'],
  Updating:       ['Running', 'Terminating'],
  Terminating:    ['Deleted'],
  Expired:        ['Deleted'],
  Deleted:        [],
};

export interface ContainerGroup {
  readonly id: string;
  readonly taskInstanceId: string;
  readonly provider: string;
  state: ContainerGroupState;
  readonly createdAt: number;
  startedAt?: number;
  completedAt?: number;
  readonly containers: readonly { name: string; state: string }[];
  readonly labels: Record<string, string>;
}

/**
 * SPEC §4.6 C4: TI.RUNNING ⇒ CG.state ∈ active_states
 * SPEC §4.6 C5: TI.{SUCCESS,FAILED} ⇒ CG.state ∈ terminal_states
 */
export function isCgConsistentWithTi(tiState: TaskInstanceState, cgState: ContainerGroupState): boolean {
  if (tiState === 'RUNNING') return !isCgTerminal(cgState);
  if (tiState === 'SUCCESS' || tiState === 'FAILED') return isCgTerminal(cgState);
  return true;
}

// ─── TaskInstance (runtime) ───

export interface TaskInstance {
  readonly id: TaskInstanceId;
  readonly taskId: TaskId;
  readonly dagRunId: DagRunId;
  state: TaskInstanceState;
  tryNumber: number;
  startedAt?: number | undefined;
  completedAt?: number | undefined;
  exitCode?: number | undefined;
  error?: string | undefined;
  output?: unknown;
  /** ID of the ContainerGroup executing this TaskInstance. */
  readonly containerGroupId?: string;
  version: VersionId;
}

// ─── DagDefinition ───

export interface DagDef {
  readonly id: DagId;
  readonly name: string;
  readonly description?: string;
  /** Tasks that form the DAG. */
  readonly tasks: readonly Task[];
  /** Maximum active TaskInstances across all DagRuns for this DAG. */
  readonly maxActiveTasks?: number;
  /** Maximum active DagRuns for this DAG. */
  readonly maxActiveRuns?: number;
  /** Cron schedule expression. */
  readonly schedule?: string;
  /** Allow catchup of missed intervals. */
  readonly catchup?: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly version: VersionId;
}

// ─── DagRun ───

export type DagRunStatus = 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED';

export interface DagRun {
  readonly id: DagRunId;
  readonly dagId: DagId;
  readonly status: DagRunStatus;
  /** Scheduled execution time (logical date in Airflow terms). */
  readonly executionDate: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly trigger: 'manual' | 'cron' | 'backfill' | 'http' | 'webhook' | 'shared_link';
  readonly triggerPayload?: unknown;
  /** Environment variables merged across the DAG. */
  readonly env: Record<string, string>;
  /** User who triggered this run. */
  readonly ownerId?: string;
  readonly error?: string;
  readonly version: VersionId;
}

// ─── Pool ───

export interface Pool {
  readonly name: string;
  readonly slots: number;
  occupiedSlots: number;
  readonly description?: string | undefined;
}

export function openSlots(pool: Pool): number {
  return Math.max(0, pool.slots - pool.occupiedSlots);
}

// ─── Executor interface ───

export interface TaskExecutionResult {
  readonly success: boolean;
  readonly exitCode?: number;
  readonly error?: string;
  readonly output?: unknown;
}

export interface ITaskExecutor {
  readonly key: string;
  execute(task: Task, ti: TaskInstance): Promise<TaskExecutionResult>;
}

// ─── Scheduler context ───

export interface SchedulerContext {
  /** Resolve a DagDef by ID. */
  getDagDef(dagId: DagId): Promise<{ value: DagDef; version: VersionId } | null>;
  /** Get all active DagRuns. */
  getActiveDagRuns(): Promise<DagRun[]>;
  /** Get a specific DagRun. */
  getDagRun(dagRunId: DagRunId): Promise<{ value: DagRun; version: VersionId } | null>;
  /** Persist a DagRun update. */
  updateDagRun(dagRun: DagRun, version: VersionId): Promise<boolean>;
  /** Get all TaskInstances for a DagRun. */
  getTaskInstances(dagRunId: DagRunId): Promise<TaskInstance[]>;
  /** Persist a TaskInstance. */
  saveTaskInstance(ti: TaskInstance, version?: VersionId | null): Promise<boolean>;
  /** Get a pool by name. */
  getPool(name: string): Promise<Pool | null>;
  /** Update pool slot occupancy. */
  updatePool(pool: Pool): Promise<boolean>;
  /** Resolve an executor by key. */
  getExecutor(key: string): Promise<ITaskExecutor | null>;
  /** Check approval status for a task. Returns 'pending' | 'approved' | 'rejected' | null. */
  getApprovalStatus(dagRunId: DagRunId, taskName: string): Promise<'pending' | 'approved' | 'rejected' | null>;
  /** Persist a ContainerGroup. */
  saveCG(cg: ContainerGroup, version?: VersionId | null): Promise<boolean>;
  /** Get a ContainerGroup by ID. */
  getCG(id: string): Promise<{ value: ContainerGroup; version: VersionId } | null>;
  /** Update a ContainerGroup with version check. */
  updateCG(cg: ContainerGroup, version: VersionId): Promise<boolean>;
  /** Get all ContainerGroups. */
  getAllCGs(): Promise<ContainerGroup[]>;
}
