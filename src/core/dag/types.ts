/**
 * Unified DAG scheduling domain types.
 *
 * Merges:
 *   - Airflow: TaskInstance 12-state, TriggerRule, Pool, DagRun
 *   - GitHub Actions: WorkflowDef → DagDefinition, JobDef → Task, JobRun → TaskInstance
 *
 * The existing `Dag<TId, TNode>` (graph.ts) provides Kahn topological sort.
 * This file defines the *domain* layer: what tasks are, how they run, and what
 * states they transition through.
 */

import type { VersionId } from '../brand.ts';

// ─── Brand types ───

declare const DAG_ID_BRAND: unique symbol;
declare const DAG_RUN_ID_BRAND: unique symbol;
declare const TASK_ID_BRAND: unique symbol;
declare const TASK_INSTANCE_ID_BRAND: unique symbol;

export type DagId = string & { readonly [DAG_ID_BRAND]: true };
export type DagRunId = string & { readonly [DAG_RUN_ID_BRAND]: true };
export type TaskId = string & { readonly [TASK_ID_BRAND]: true };
export type TaskInstanceId = string & { readonly [TASK_INSTANCE_ID_BRAND]: true };

export function createDagId(raw: string): DagId { return raw as DagId; }
export function createDagRunId(raw: string): DagRunId { return raw as DagRunId; }
export function createTaskId(raw: string): TaskId { return raw as TaskId; }
export function createTaskInstanceId(raw: string): TaskInstanceId { return raw as TaskInstanceId; }

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
  | 'run'        // shell command inside container
  | 'uses'       // reusable action reference (container image or JS)
  | 'dns'        // DNS record upsert/delete
  | 'sandbox'    // provision a full container group
  | 'noop';      // no-op (placeholder / passthrough)

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
  NONE:              ['SCHEDULED', 'REMOVED'],
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
}
