import { Dag } from './graph.ts';

/** Minimum contract a task must satisfy to participate in DAG orchestration. */
export interface OrchestratedTask {
  readonly id: string;
  readonly dependsOn: readonly string[];
}

/** Result of executing a single task. */
export interface OrchestratedTaskResult {
  readonly id: string;
  readonly success: boolean;
  readonly error?: string | undefined;
}

/** Final result of orchestrating all tasks. */
export interface OrchestrationResult {
  readonly success: boolean;
  readonly results: readonly OrchestratedTaskResult[];
}

/**
 * Generic DAG-based task orchestrator.
 *
 * Takes a list of tasks with dependency declarations, topologically sorts them
 * into batches (all tasks whose dependencies are met), and executes each batch
 * concurrently via the caller-supplied executor function.
 *
 * Failures are collected per-task — one failed task does not cancel its batch
 * siblings, but dependent tasks in later batches are skipped.
 *
 * @example
 * ```ts
 * const orchestrator = new DagOrchestrator();
 * const result = await orchestrator.execute(tasks, async (task) => {
 *   await containerProvider.create(task.spec);
 * });
 * ```
 */
export class DagOrchestrator<T extends OrchestratedTask> {
  /**
   * Execute a set of tasks in DAG order.
   *
   * @param tasks  - All tasks to execute.
   * @param executor - Async function that performs the actual work for a task.
   *                   If it throws, the task is marked as failed.
   */
  public async execute(
    tasks: readonly T[],
    executor: (task: T) => Promise<void>,
  ): Promise<OrchestrationResult> {
    if (tasks.length === 0) return { success: true, results: [] };

    // 1. Build DAG
    const dag = new Dag<string, T>(t => t.id);
    for (const task of tasks) dag.addNode(task);
    for (const task of tasks) {
      for (const dep of task.dependsOn) {
        dag.addEdge(task.id, dep);
      }
    }

    // 2. Topological sort — produces batches implicitly (all in-degree-0 nodes
    //    at each iteration form a batch).
    const sorted = dag.topologicalSort();
    if (!sorted.success) {
      return {
        success: false,
        results: sorted.sorted.map(n => ({ id: n.id, success: false, error: `Cycle detected: ${sorted.error}` })),
      };
    }

    // 3. Execute batch-by-batch using Kahn's algorithm semantics.
    //    We track completed nodes and, each iteration, pick nodes whose
    //    dependencies have all been satisfied.
    const results: OrchestratedTaskResult[] = [];
    const completed = new Set<string>();
    const pending = new Set(sorted.sorted.map(t => t.id));

    while (pending.size > 0) {
      const batch = [...pending].filter(id => {
        const node = dag.getNode(id);
        return node && node.dependsOn.every(d => completed.has(d));
      });

      if (batch.length === 0) {
        // Remaining tasks have unsatisfied deps (shouldn't happen since topo
        // sort succeeded, but guard against logic errors).
        for (const id of pending) {
          results.push({ id, success: false, error: 'Unsatisfied dependency' });
        }
        break;
      }

      const batchResults = await Promise.allSettled(
        batch.map(async (id) => {
          const task = dag.getNode(id)!;
          try {
            await executor(task);
            return { id: task.id, success: true };
          } catch (e) {
            return { id: task.id, success: false, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );

      for (const r of batchResults) {
        const result = r.status === 'fulfilled'
          ? r.value
          : { id: '(unknown)', success: false, error: r.reason?.message ?? String(r.reason) };
        results.push(result);
        if (result.success) {
          completed.add(result.id);
        }
        pending.delete(result.id);
      }
    }

    return {
      success: results.every(r => r.success),
      results,
    };
  }
}
