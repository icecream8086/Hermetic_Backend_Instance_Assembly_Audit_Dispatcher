import type {
  SchedulableTask,
  ResourceNode,
  ResourceSnapshot,
  Schedule,
  ScheduleEntry,
} from './types.ts';
import type { ISchedulingStrategy, IResourceAllocator } from './interfaces.ts';
import { Dag } from '../../dag/graph.ts';

/**
 * Default scheduling configuration.
 */
export interface DagSchedulerConfig {
  strategy: ISchedulingStrategy;
  allocator: IResourceAllocator;
}

/**
 * Generic DAG-based task scheduler.
 *
 * Takes tasks with resource requirements and a pool of resources,
 * and produces a Schedule that respects:
 *   1. DAG dependency order (no task starts before its dependencies finish)
 *   2. Resource capacity (no over-commit)
 *   3. Strategy-specific optimization (CPM for makespan, etc.)
 *
 * Algorithm (event-driven simulation):
 *   1. Build DAG from task dependencies
 *   2. Topological sort to verify acyclicity
 *   3. Maintain a clock, ready queue, and resource snapshots
 *   4. At each event (task completion), re-evaluate ready tasks
 *   5. Dispatch ready tasks via strategy + allocator
 *   6. Advance clock to next completion event
 *
 * Same abstraction level as src/core/dag/orchestrator.ts.
 *
 * @example
 * ```ts
 * const scheduler = new DagScheduler({
 *   strategy: new CriticalPathStrategy(tasks),
 *   allocator: new LeastRequestedAllocator(),
 * });
 * const schedule = scheduler.schedule(tasks, runners);
 * console.log('makespan:', schedule.makespan);
 * ```
 */
export class DagScheduler {
  public constructor(private readonly config: DagSchedulerConfig) {}

  schedule(
    tasks: readonly SchedulableTask[],
    resources: readonly ResourceNode[],
  ): Schedule {
    if (tasks.length === 0) {
      return { entries: [], makespan: 0, unassigned: [] };
    }

    // 1. Build & validate DAG
    const dag = new Dag<string, SchedulableTask>(t => t.id);
    for (const t of tasks) dag.addNode(t);
    for (const t of tasks) {
      for (const dep of t.dependsOn) {
        if (dag.hasNode(dep)) dag.addEdge(t.id, dep);
      }
    }
    const topo = dag.topologicalSort();
    if (!topo.success) {
      return { entries: [], makespan: 0, unassigned: tasks.map(t => t.id) };
    }

    // 2. Initialise state
    const entries: ScheduleEntry[] = [];
    const completed = new Set<string>();
    const taskCompletionTime = new Map<string, number>(); // taskId → completionTime (0 = not started)
    let clock = 0;

    // Resource snapshots — track availableAt per resource
    const snapshots = new Map<string, ResourceSnapshot>();
    for (const r of resources) {
      snapshots.set(r.id, {
        node: r,
        available: { ...r.capacity },
        availableAt: 0,
      });
    }

    // 3. Event-driven loop
    while (completed.size < tasks.length) {
      // Collect ready tasks — all deps completed, not yet scheduled
      const ready: SchedulableTask[] = [];
      for (const t of tasks) {
        if (completed.has(t.id)) continue;
        if (taskCompletionTime.has(t.id)) continue; // already scheduled, running

        const depsDone = t.dependsOn.every(d => completed.has(d));
        if (!depsDone) continue;

        ready.push(t);
      }

      if (ready.length === 0) {
        // All remaining tasks are currently running. Advance clock to
        // the next completion event to free resources.
        const nextCompletion = findEarliestCompletion(taskCompletionTime, completed);
        if (nextCompletion === null) break;
        clock = nextCompletion;
        // Mark tasks that completed at or before the new clock
        for (const [taskId, compTime] of taskCompletionTime) {
          if (compTime <= clock && !completed.has(taskId)) {
            completed.add(taskId);
            const entry = entries.find(e => e.taskId === taskId);
            if (entry) {
              const snap = snapshots.get(entry.resourceId);
              const task = tasks.find(t => t.id === taskId);
              if (snap && task) {
                snapshots.set(entry.resourceId, {
                  ...snap,
                  available: add(snap.available, task.requirements),
                });
              }
            }
          }
        }
        continue;
      }

      // Order ready tasks by strategy
      const ordered = this.config.strategy.order(ready);

      // Try to assign each ready task to a resource
      let assignedAny = false;
      for (const task of ordered) {
        const resList = [...snapshots.values()];

        // Advance each resource's availableAt to at least clock
        for (const [rid, snap] of snapshots) {
          if (snap.availableAt < clock) {
            snapshots.set(rid, { ...snap, availableAt: clock });
          }
        }

        const chosenId = this.config.allocator.select(task, resList);
        if (chosenId === null) continue; // can't assign now, try later

        const chosen = snapshots.get(chosenId)!;
        const startTime = Math.max(clock, chosen.availableAt);
        const completionTime = startTime + task.estimatedDuration;

        // Consume capacity
        const newAvail = subtract(chosen.available, task.requirements);
        snapshots.set(chosenId, {
          ...chosen,
          available: newAvail,
          availableAt: completionTime,
        });

        entries.push({ taskId: task.id, resourceId: chosenId, startTime, completionTime });
        taskCompletionTime.set(task.id, completionTime);
        assignedAny = true;
      }

      if (!assignedAny) {
        // Resource shortage — advance clock to next completion to free capacity
        const nextCompletion = findEarliestCompletion(taskCompletionTime, completed);
        if (nextCompletion === null) break;
        clock = nextCompletion;

        // Release resources of completed tasks
        for (const [taskId, compTime] of taskCompletionTime) {
          if (compTime <= clock && !completed.has(taskId)) {
            completed.add(taskId);
            // Release capacity
            const entry = entries.find(e => e.taskId === taskId);
            if (entry) {
              const snap = snapshots.get(entry.resourceId);
              if (snap) {
                const task = tasks.find(t => t.id === taskId);
                if (task) {
                  snapshots.set(entry.resourceId, {
                    ...snap,
                    available: add(snap.available, task.requirements),
                  });
                }
              }
            }
          }
        }
        continue;
      }

      // Advance clock to next completion event
      const nextCompletion = findEarliestCompletion(taskCompletionTime, completed);
      if (nextCompletion === null) break;
      clock = nextCompletion;

      // Mark completed tasks and release resources
      for (const [taskId, compTime] of taskCompletionTime) {
        if (compTime <= clock && !completed.has(taskId)) {
          completed.add(taskId);
          const entry = entries.find(e => e.taskId === taskId);
          if (entry) {
            const snap = snapshots.get(entry.resourceId);
            const task = tasks.find(t => t.id === taskId);
            if (snap && task) {
              snapshots.set(entry.resourceId, {
                ...snap,
                available: add(snap.available, task.requirements),
              });
            }
          }
        }
      }
    }

    // Collect unassigned (tasks that never got an entry)
    const assignedIds = new Set(entries.map(e => e.taskId));
    const unassigned = tasks.filter(t => !assignedIds.has(t.id)).map(t => t.id);
    const makespan = entries.reduce((max, e) => Math.max(max, e.completionTime), 0);

    return { entries, makespan, unassigned };
  }
}

// ─── Helpers ───

function subtract(a: { cpu: number; memory: number; gpu?: number }, b: { cpu: number; memory: number; gpu?: number }): { cpu: number; memory: number; gpu?: number } {
  return {
    cpu: a.cpu - b.cpu,
    memory: a.memory - b.memory,
    ...(a.gpu !== undefined || b.gpu !== undefined ? { gpu: (a.gpu ?? 0) - (b.gpu ?? 0) } : {}),
  };
}

function add(a: { cpu: number; memory: number; gpu?: number }, b: { cpu: number; memory: number; gpu?: number }): { cpu: number; memory: number; gpu?: number } {
  return {
    cpu: a.cpu + b.cpu,
    memory: a.memory + b.memory,
    ...(a.gpu !== undefined || b.gpu !== undefined ? { gpu: (a.gpu ?? 0) + (b.gpu ?? 0) } : {}),
  };
}

function findEarliestCompletion(
  completionTimes: Map<string, number>,
  completed: Set<string>,
): number | null {
  let earliest = Infinity;
  for (const [id, t] of completionTimes) {
    if (!completed.has(id) && t < earliest) earliest = t;
  }
  return earliest === Infinity ? null : earliest;
}
