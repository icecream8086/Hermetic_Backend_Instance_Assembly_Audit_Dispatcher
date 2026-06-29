import type { TaskInstance } from '../dag/types.ts';

/**
 * ConcurrencyMap — O(1) lookup of active task counts.
 *
 * Maps: dag_id → { active_tis, task_id → { active_tis }, dagrun_id → { active_tis } }
 *
 * Used by the 5-step filter pipeline to enforce:
 *   - max_active_tasks (per DAG)
 *   - max_active_tis_per_dag (per Task)
 *   - max_active_tis_per_dagrun (per DagRun)
 *
 * This is a pure in-memory structure rebuilt each scheduler tick.
 */

export interface ConcurrencyCounts {
  /** Total running TaskInstances for this DAG. */
  dagActive: number;
  /** Running TaskInstances per task in this DAG. */
  taskActive: Map<string, number>;
  /** Running TaskInstances per DagRun in this DAG. */
  dagRunActive: Map<string, number>;
}

export class ConcurrencyMap {
  private readonly counts = new Map<string, ConcurrencyCounts>();

  /** Build the map from a list of active (non-terminal) TaskInstances. */
  public constructor(activeTis: readonly TaskInstance[]) {
    for (const ti of activeTis) {
      this.add(ti);
    }
  }

  private add(ti: TaskInstance): void {
    // dagRunId format: dr_<dagId>_<execDate>_<uuid> — extract second segment
    const parts = ti.dagRunId.split('_');
    const dagId = parts.length >= 3 && parts[0] === 'dr' ? parts[1]! : (parts.length >= 2 ? parts[1]! : parts[0]!);

    let c = this.counts.get(dagId);
    if (!c) {
      c = { dagActive: 0, taskActive: new Map(), dagRunActive: new Map() };
      this.counts.set(dagId, c);
    }

    c.dagActive++;
    c.taskActive.set(ti.taskId, (c.taskActive.get(ti.taskId) ?? 0) + 1);
    c.dagRunActive.set(ti.dagRunId, (c.dagRunActive.get(ti.dagRunId) ?? 0) + 1);
  }

  /** How many active TIs exist for this DAG across all DagRuns? */
  public dagActiveCount(dagId: string): number {
    return this.counts.get(dagId)?.dagActive ?? 0;
  }

  /** How many active TIs exist for this specific task? */
  public taskActiveCount(dagId: string, taskId: string): number {
    return this.counts.get(dagId)?.taskActive.get(taskId) ?? 0;
  }

  /** How many active TIs exist for this specific DagRun? */
  public dagRunActiveCount(dagId: string, dagRunId: string): number {
    return this.counts.get(dagId)?.dagRunActive.get(dagRunId) ?? 0;
  }
}
