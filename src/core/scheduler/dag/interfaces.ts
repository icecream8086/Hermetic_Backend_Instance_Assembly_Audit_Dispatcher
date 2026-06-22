import type {
  SchedulableTask,
  ResourceNode,
  ResourceSnapshot,
  Schedule,
} from './types.ts';

/** Pluggable strategy for ordering ready tasks. */
export interface ISchedulingStrategy {
  readonly name: string;
  order(ready: readonly SchedulableTask[]): readonly SchedulableTask[];
}

/** Pluggable strategy for resource assignment. */
export interface IResourceAllocator {
  readonly name: string;
  select(task: SchedulableTask, resources: readonly ResourceSnapshot[]): string | null;
}

/** Core DAG scheduling contract. */
export interface IDagScheduler {
  schedule(tasks: readonly SchedulableTask[], resources: readonly ResourceNode[]): Schedule;
}
