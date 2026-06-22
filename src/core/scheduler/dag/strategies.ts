import type { ISchedulingStrategy, IResourceAllocator } from './interfaces.ts';
import type { SchedulableTask, ResourceSnapshot, ResourceVector } from './types.ts';

// ═══════════════════════════════════════════════════════════════
// Task ordering strategies
// ═══════════════════════════════════════════════════════════════

/** First-Come, First-Served — preserves input order. */
export class FcfsStrategy implements ISchedulingStrategy {
  readonly name = 'FCFS';
  order(ready: readonly SchedulableTask[]): readonly SchedulableTask[] {
    return ready;
  }
}

/** Priority scheduling — higher priority first, ties broken by FCFS. */
export class PriorityStrategy implements ISchedulingStrategy {
  readonly name = 'Priority';
  order(ready: readonly SchedulableTask[]): readonly SchedulableTask[] {
    return [...ready].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }
}

/** Shortest Job First — smallest estimatedDuration first. */
export class SjfStrategy implements ISchedulingStrategy {
  readonly name = 'SJF';
  order(ready: readonly SchedulableTask[]): readonly SchedulableTask[] {
    return [...ready].sort((a, b) => a.estimatedDuration - b.estimatedDuration);
  }
}

/**
 * Critical Path Method (CPM) — tasks on the critical path first.
 *
 * The critical path is determined by computing the longest path from
 * a task to any sink task (bottom-up).  Tasks with higher rank are
 * on the critical path and should be scheduled first to minimize makespan.
 */
export class CriticalPathStrategy implements ISchedulingStrategy {
  readonly name = 'CPM';
  readonly #ranks: Map<string, number>;

  /**
   * @param allTasks  — all tasks in the workflow (needed to compute ranks).
   *                    Tasks with estimatedDuration = 0 get default 1ms.
   */
  constructor(allTasks: readonly SchedulableTask[]) {
    this.#ranks = computeUpwardRanks(allTasks);
  }

  order(ready: readonly SchedulableTask[]): readonly SchedulableTask[] {
    return [...ready].sort((a, b) => {
      const ra = this.#ranks.get(a.id) ?? 0;
      const rb = this.#ranks.get(b.id) ?? 0;
      return rb - ra; // higher rank first
    });
  }
}

/**
 * HEFT task priority — uses upward rank (average across resource types).
 * For homogeneous resources, this is equivalent to CPM.
 */
export class HeftTaskPriorityStrategy implements ISchedulingStrategy {
  readonly name = 'HEFT-Priority';
  readonly #ranks: Map<string, number>;

  constructor(allTasks: readonly SchedulableTask[]) {
    this.#ranks = computeUpwardRanks(allTasks);
  }

  order(ready: readonly SchedulableTask[]): readonly SchedulableTask[] {
    return [...ready].sort((a, b) => {
      const ra = this.#ranks.get(a.id) ?? 0;
      const rb = this.#ranks.get(b.id) ?? 0;
      return rb - ra;
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// Resource allocation strategies
// ═══════════════════════════════════════════════════════════════

/**
 * First-Fit — assign to the first resource with enough available capacity.
 */
export class FirstFitAllocator implements IResourceAllocator {
  readonly name = 'FirstFit';

  select(task: SchedulableTask, resources: readonly ResourceSnapshot[]): string | null {
    for (const r of resources) {
      if (fits(task.requirements, r.available)) {
        return r.node.id;
      }
    }
    return null;
  }
}

/**
 * Least-Requested — assign to the resource with the most available capacity
 * (i.e., lowest utilization).  Equivalent to K8s LeastRequestedPriority.
 */
export class LeastRequestedAllocator implements IResourceAllocator {
  readonly name = 'LeastRequested';

  select(task: SchedulableTask, resources: readonly ResourceSnapshot[]): string | null {
    let best: string | null = null;
    let bestUtil = Infinity;

    for (const r of resources) {
      if (!fits(task.requirements, r.available)) continue;
      const util = utilization(r);
      if (util < bestUtil) {
        bestUtil = util;
        best = r.node.id;
      }
    }
    return best;
  }
}

/**
 * HEFT processor selection — choose the resource that gives the
 * earliest finish time for the task.
 */
export class HeftAllocator implements IResourceAllocator {
  readonly name = 'HEFT';

  select(task: SchedulableTask, resources: readonly ResourceSnapshot[]): string | null {
    let best: string | null = null;
    let bestFinish = Infinity;

    for (const r of resources) {
      if (!fits(task.requirements, r.available)) continue;
      const finish = Math.max(r.availableAt, 0) + task.estimatedDuration;
      if (finish < bestFinish) {
        bestFinish = finish;
        best = r.node.id;
      }
    }
    return best;
  }
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function fits(need: ResourceVector, avail: ResourceVector): boolean {
  if (avail.cpu < need.cpu) return false;
  if (avail.memory < need.memory) return false;
  if (need.gpu !== undefined && (avail.gpu ?? 0) < need.gpu) return false;
  return true;
}

function utilization(r: ResourceSnapshot): number {
  const cu = r.available.cpu / (r.node.capacity.cpu || 1);
  const mu = r.available.memory / (r.node.capacity.memory || 1);
  return (cu + mu) / 2; // average utilization (lower = more available)
}

/**
 * Compute upward rank for all tasks (bottom-up dynamic programming).
 *
 * upward_rank(t) = duration(t) + max_{child ∈ successors(t)} upward_rank(child)
 *
 * For sink tasks (no successors), upward_rank = estimatedDuration.
 * Tasks with higher rank are on the critical path.
 */
export function computeUpwardRanks(
  tasks: readonly SchedulableTask[],
): Map<string, number> {
  const ranks = new Map<string, number>();
  const idSet = new Set(tasks.map(t => t.id));

  // Build successor map
  const successors = new Map<string, string[]>();
  for (const t of tasks) successors.set(t.id, []);
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (idSet.has(dep)) {
        const s = successors.get(dep);
        if (s && !s.includes(t.id)) s.push(t.id);
      }
    }
  }

  function dfs(id: string): number {
    const cached = ranks.get(id);
    if (cached !== undefined) return cached;

    const task = tasks.find(t => t.id === id);
    if (!task) { ranks.set(id, 0); return 0; }

    let maxChild = 0;
    for (const c of successors.get(id) ?? []) {
      maxChild = Math.max(maxChild, dfs(c));
    }
    const rank = task.estimatedDuration + maxChild;
    ranks.set(id, rank);
    return rank;
  }

  for (const t of tasks) dfs(t.id);
  return ranks;
}
