// ─── Core scheduler types ───
// Same abstraction level as core/dag/ — generic, reusable scheduling primitives.

/**
 * Minimum contract for a task to be scheduled.
 * Extends the DAG's OrchestratedTask with resource requirements and timing estimates.
 */
export interface SchedulableTask {
  readonly id: string;
  /** Task IDs this task depends on. */
  readonly dependsOn: readonly string[];
  /** Estimated execution duration (ms). Used by CPM/HEFT for makespan optimization. */
  readonly estimatedDuration: number;
  /** Required resource quantity per dimension. */
  readonly requirements: ResourceVector;
  /** Priority (higher = more urgent). Used by priority scheduling. */
  readonly priority?: number;
}

/** Multi-dimensional resource vector (e.g. { cpu: 2, memory: 4096 }). */
export interface ResourceVector {
  readonly cpu: number;
  readonly memory: number;
  readonly gpu?: number;
}

/** A resource node (Runner) that can execute tasks. */
export interface ResourceNode {
  readonly id: string;
  /** Total capacity of this node. */
  readonly capacity: ResourceVector;
  /** Labels for affinity/anti-affinity matching. */
  readonly labels: Readonly<Record<string, string>>;
  /** Optional label requirements for tasks that can run on this node. */
  readonly supportedLabels?: readonly string[];
}

/** A single task assignment: task → resource, with start/completion times. */
export interface ScheduleEntry {
  readonly taskId: string;
  readonly resourceId: string;
  /** Absolute start time (ms from schedule origin). */
  readonly startTime: number;
  /** Absolute completion time (ms from schedule origin). */
  readonly completionTime: number;
}

/** Complete schedule for a set of tasks on a set of resources. */
export interface Schedule {
  readonly entries: readonly ScheduleEntry[];
  /** Total makespan (max completionTime). */
  readonly makespan: number;
  /** Tasks that could not be assigned (resource shortage, cycle, etc.). */
  readonly unassigned: readonly string[];
}

/** Snapshot of a resource node's available capacity at a point in time. */
export interface ResourceSnapshot {
  readonly node: ResourceNode;
  /** Remaining available capacity. */
  readonly available: ResourceVector;
  /** Earliest time this resource becomes available for the next task. */
  readonly availableAt: number;
}
