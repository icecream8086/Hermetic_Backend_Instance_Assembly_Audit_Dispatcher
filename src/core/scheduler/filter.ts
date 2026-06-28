import type { TaskInstance, Task } from '../dag/types.ts';
import type { ConcurrencyMap } from './concurrency-map.ts';

/**
 * 5-step filter pipeline — Airflow `_executable_task_instances_to_queued()`.
 *
 * Given a set of SCHEDULED TaskInstances, each step filters out tasks that
 * exceed concurrency limits. Tasks that pass all 5 steps are eligible to
 * advance to QUEUED.
 *
 * Step order (matches Airflow):
 *   1. Pool slot check — pool has room?
 *   2. DAG concurrency (max_active_tasks) — too many active TIs for this DAG?
 *   3. Task concurrency (max_active_tis_per_dag) — too many instances of this task?
 *   4. DagRun concurrency (max_active_tis_per_dagrun) — too many in this specific run?
 *   5. Executor slot (parallelism) — overall system limit?
 */

export interface FilterContext {
  readonly tasks: ReadonlyMap<string, Task>;
  readonly poolSlots: ReadonlyMap<string, number>;  // pool name → open slots
  readonly dagMaxActive: ReadonlyMap<string, number>;  // dagId → max_active_tasks
  readonly concurrencyMap: ConcurrencyMap;
  readonly parallelism: number;  // max total concurrent executions
  readonly alreadyQueued: number;  // already-queued count from this tick
}

export interface FilterResult {
  /** Tasks that passed all 5 filters — can advance to QUEUED. */
  readonly passed: readonly TaskInstance[];
  /** Starvation counts per filter step (for diagnostics/audit). */
  readonly starved: StarvationCounts;
}

export interface StarvationCounts {
  pool: number;
  dag: number;
  task: number;
  dagRun: number;
  executor: number;
}

export function emptyStarvation(): StarvationCounts {
  return { pool: 0, dag: 0, task: 0, dagRun: 0, executor: 0 };
}

/**
 * Extract dagId from dagRunId.
 * Format: `dr_<dagId>_<execDate>_<uuid>` — dagId is between first and second `_`.
 */
function dagIdFromRun(dagRunId: string): string {
  const parts = dagRunId.split('_');
  // Format: dr_<dagId>_...
  if (parts.length >= 2 && parts[0] === 'dr') {
    return parts[1]!;
  }
  // Fallback: everything before second underscore
  return parts.length >= 3 ? parts[1]! : dagRunId;
}

/**
 * Run the 5-step filter on a batch of SCHEDULED TaskInstances.
 * Returns the subset that can proceed to QUEUED.
 */
export function filterScheduledTasks(
  scheduled: readonly TaskInstance[],
  ctx: FilterContext,
): FilterResult {
  const starved: StarvationCounts = emptyStarvation();

  // Track pool slot usage within this tick (local to this filter call)
  const localPoolUsage = new Map<string, number>();

  const passed: TaskInstance[] = [];

  for (const ti of scheduled) {
    const task = ctx.tasks.get(ti.taskId);
    const dagId = dagIdFromRun(ti.dagRunId);

    // Step 1: Pool slot check
    const poolName = task?.pool ?? 'default_pool';
    const poolOpenSlots = ctx.poolSlots.get(poolName) ?? 128; // default_pool → 128
    const localUsed = localPoolUsage.get(poolName) ?? 0;
    if (poolOpenSlots - localUsed <= 0) {
      starved.pool++;
      continue;
    }

    // Step 2: DAG concurrency
    const maxDagActive = ctx.dagMaxActive.get(dagId) ?? 16;
    if (ctx.concurrencyMap.dagActiveCount(dagId) >= maxDagActive) {
      starved.dag++;
      continue;
    }

    // Step 3: Task concurrency
    const maxTaskActive = task?.maxActiveTisPerDag ?? 16;
    if (ctx.concurrencyMap.taskActiveCount(dagId, ti.taskId) >= maxTaskActive) {
      starved.task++;
      continue;
    }

    // Step 4: DagRun concurrency (default: no limit = large number)
    // We check: have we exceeded the limit for this specific DagRun?
    // Default matches Airflow — max_active_tis_per_dagrun defaults to
    // dagrun's own task count.
    if (ctx.concurrencyMap.dagRunActiveCount(dagId, ti.dagRunId) >= 256) {
      starved.dagRun++;
      continue;
    }

    // Step 5: Executor slot (parallelism)
    // Count: already-running + already-queued-this-tick + about-to-queue
    const projectedActive = ctx.concurrencyMap.dagActiveCount(dagId) +
      ctx.alreadyQueued + passed.length;
    if (projectedActive >= ctx.parallelism) {
      starved.executor++;
      continue;
    }

    // All checks passed — claim local pool slot and add to passed
    localPoolUsage.set(poolName, localUsed + 1);
    passed.push(ti);
  }

  return { passed, starved };
}
