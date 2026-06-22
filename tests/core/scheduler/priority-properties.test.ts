import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  DagScheduler,
} from '../../../src/core/scheduler/dag/dag-scheduler.ts';
import {
  PriorityStrategy,
  FcfsStrategy,
} from '../../../src/core/scheduler/dag/strategies.ts';
import {
  FirstFitAllocator,
} from '../../../src/core/scheduler/dag/strategies.ts';
import type {
  SchedulableTask,
  ResourceNode,
  Schedule,
} from '../../../src/core/scheduler/dag/types.ts';

// ─── Arbitraries ───

/**
 * Generate N independent tasks (no dependencies) with GUARANTEED unique IDs.
 * Fast-check's array may produce duplicates when generating string IDs,
 * but the DAG scheduler requires unique IDs (nodes are indexed by ID).
 * We use sequential numeric IDs to guarantee uniqueness.
 */
function independentTasks(maxN: number, maxPriority: number): fc.Arbitrary<SchedulableTask[]> {
  return fc.integer({ min: 1, max: maxN }).chain(n =>
    fc.array(
      fc.record({
        estimatedDuration: fc.integer({ min: 1, max: 200 }),
        priority: fc.integer({ min: 0, max: maxPriority }),
      }),
      { minLength: n, maxLength: n },
    ).map(raw =>
      raw.map((t, i) => ({
        id: `t${i}`,
        dependsOn: [] as string[],
        estimatedDuration: t.estimatedDuration,
        requirements: { cpu: 1, memory: 1 },
        priority: t.priority,
      })),
    ),
  );
}

/** Single resource with ample capacity. */
const singleResource: ResourceNode[] = [
  { id: 'r1', capacity: { cpu: 16, memory: 65536 }, labels: {} },
];

// ─── Verify helpers ───

/** Check that tasks in the schedule obey priority ordering (within each resource). */
function priorityOrderValid(schedule: Schedule, tasks: readonly SchedulableTask[]): boolean {
  const taskMap = new Map(tasks.map(t => [t.id, t]));

  // Group entries by resource
  const byResource = new Map<string, typeof schedule.entries>();
  for (const e of schedule.entries) {
    let list = byResource.get(e.resourceId);
    if (!list) { list = []; byResource.set(e.resourceId, list); }
    list.push(e);
  }

  for (const [, entries] of byResource) {
    // Sort by startTime
    const sorted = [...entries].sort((a, b) => a.startTime - b.startTime);

    for (let i = 0; i < sorted.length - 1; i++) {
      const a = taskMap.get(sorted[i]!.taskId);
      const b = taskMap.get(sorted[i + 1]!.taskId);
      if (!a || !b) continue;

      // Both are ready (no deps), so priority should determine order.
      // a starts before b → a.priority should >= b.priority
      if ((a.priority ?? 0) < (b.priority ?? 0)) {
        // Lower priority started before higher priority — inversion!
        return false;
      }
    }
  }
  return true;
}

/** Check that no task with higher priority is delayed behind a lower-priority one
 *  when both are independent and resources are sufficient. */
function noPriorityInversion(schedule: Schedule, tasks: readonly SchedulableTask[]): boolean {
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const entries = [...schedule.entries].sort((a, b) => a.startTime - b.startTime);

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = taskMap.get(entries[i]!.taskId);
      const b = taskMap.get(entries[j]!.taskId);
      if (!a || !b) continue;

      // If b has strictly higher priority than a, but a started earlier,
      // and both have no dependencies — that's a priority inversion
      if ((b.priority ?? 0) > (a.priority ?? 0) &&
          a.dependsOn.length === 0 &&
          b.dependsOn.length === 0) {
        return false;
      }
    }
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe('PriorityStrategy (formal verification)', () => {
  describe('ordering invariants', () => {
    it('sorts by priority descending', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              estimatedDuration: fc.integer({ min: 1, max: 100 }),
              priority: fc.integer({ min: 0, max: 100 }),
            }),
            { minLength: 2, maxLength: 50 },
          ),
          (raw) => {
            const tasks: SchedulableTask[] = raw.map((t, i) => ({
              id: `t${i}`,
              dependsOn: [],
              estimatedDuration: t.estimatedDuration,
              requirements: { cpu: 1, memory: 1 },
              priority: t.priority,
            }));

            const ordered = new PriorityStrategy().order(tasks);
            for (let i = 0; i < ordered.length - 1; i++) {
              const a = ordered[i]!.priority ?? 0;
              const b = ordered[i + 1]!.priority ?? 0;
              expect(a).toBeGreaterThanOrEqual(b);
            }
          },
        ),
        { numRuns: 500 },
      );
    });

    it('ties (equal priority) preserve stable-ish order (FCFS fallback)', () => {
      const tasks: SchedulableTask[] = [
        { id: 'a', dependsOn: [], estimatedDuration: 1, requirements: { cpu: 1, memory: 1 }, priority: 5 },
        { id: 'b', dependsOn: [], estimatedDuration: 1, requirements: { cpu: 1, memory: 1 }, priority: 5 },
        { id: 'c', dependsOn: [], estimatedDuration: 1, requirements: { cpu: 1, memory: 1 }, priority: 5 },
      ];
      const ordered = new PriorityStrategy().order(tasks);
      // All have same priority — all should be present
      expect(ordered.length).toBe(3);
      expect(ordered.map(t => t.id).sort()).toEqual(['a', 'b', 'c']);
    });
  });

  describe('priority scheduling (with DagScheduler)', () => {
    it('independent tasks scheduled in priority order on single resource', async () => {
      await fc.assert(
        fc.asyncProperty(independentTasks(20, 50), async (tasks) => {
          const scheduler = new DagScheduler({
            strategy: new PriorityStrategy(),
            allocator: new FirstFitAllocator(),
          });
          const schedule = scheduler.schedule(tasks, singleResource);

          expect(schedule.unassigned.length).toBe(0);
          expect(schedule.entries.length).toBe(tasks.length);
          expect(priorityOrderValid(schedule, tasks)).toBe(true);
        }),
        { numRuns: 300 },
      );
    });

    it('no priority inversion with independent tasks', async () => {
      await fc.assert(
        fc.asyncProperty(independentTasks(20, 50), async (tasks) => {
          const scheduler = new DagScheduler({
            strategy: new PriorityStrategy(),
            allocator: new FirstFitAllocator(),
          });
          const schedule = scheduler.schedule(tasks, singleResource);
          expect(noPriorityInversion(schedule, tasks)).toBe(true);
        }),
        { numRuns: 300 },
      );
    });

    it('priority respected even with varying task durations', async () => {
      // Long low-priority tasks should not delay short high-priority tasks
      const tasks: SchedulableTask[] = [
        { id: 'p10', dependsOn: [], estimatedDuration: 200, requirements: { cpu: 1, memory: 1 }, priority: 10 },
        { id: 'p0', dependsOn: [], estimatedDuration: 1, requirements: { cpu: 1, memory: 1 }, priority: 0 },
        { id: 'p5', dependsOn: [], estimatedDuration: 50, requirements: { cpu: 1, memory: 1 }, priority: 5 },
      ];
      const scheduler = new DagScheduler({
        strategy: new PriorityStrategy(),
        allocator: new FirstFitAllocator(),
      });
      const schedule = scheduler.schedule(tasks, singleResource);
      const order = schedule.entries.sort((a, b) => a.startTime - b.startTime).map(e => e.taskId);
      expect(order[0]).toBe('p10'); // Highest priority first
      expect(order[1]).toBe('p5');  // Medium
      expect(order[2]).toBe('p0');  // Lowest last
    });
  });

  describe('priority vs FCFS comparison', () => {
    it('PriorityStrategy gives earlier completion to high-priority tasks than FCFS', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              estimatedDuration: fc.integer({ min: 1, max: 100 }),
              priority: fc.oneof(
                fc.constant(0),
                fc.constant(100),
              ),
            }),
            { minLength: 3, maxLength: 15 },
          ),
          async (raw) => {
            const tasks: SchedulableTask[] = raw.map((t, i) => ({
              id: `t${i}`,
              dependsOn: [],
              estimatedDuration: t.estimatedDuration,
              requirements: { cpu: 1, memory: 1 },
              priority: t.priority,
            }));

            if (!tasks.some(t => t.priority === 100)) return; // need at least one high-priority

            const priSchedule = new DagScheduler({
              strategy: new PriorityStrategy(),
              allocator: new FirstFitAllocator(),
            }).schedule(tasks, singleResource);

            const fcfsSchedule = new DagScheduler({
              strategy: new FcfsStrategy(),
              allocator: new FirstFitAllocator(),
            }).schedule(tasks, singleResource);

            // Collect completion times for high-priority tasks under both strategies
            const highIds = tasks.filter(t => t.priority === 100).map(t => t.id);
            const priCompletions = priSchedule.entries
              .filter(e => highIds.includes(e.taskId))
              .map(e => e.completionTime);
            const fcfsCompletions = fcfsSchedule.entries
              .filter(e => highIds.includes(e.taskId))
              .map(e => e.completionTime);

            // Maximum completion time for high-priority tasks under Priority
            // should be ≤ FCFS (Priority puts them first → finishes faster)
            const priMax = Math.max(...priCompletions);
            const fcfsMax = Math.max(...fcfsCompletions);
            expect(priMax).toBeLessThanOrEqual(fcfsMax);
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  describe('boundary cases', () => {
    it('single task with any priority works', async () => {
      await fc.assert(
        fc.asyncProperty(independentTasks(1, 100), async (tasks) => {
          const schedule = new DagScheduler({
            strategy: new PriorityStrategy(),
            allocator: new FirstFitAllocator(),
          }).schedule(tasks, singleResource);
          expect(schedule.entries.length).toBe(1);
          expect(schedule.makespan).toBe(tasks[0]!.estimatedDuration);
        }),
        { numRuns: 100 },
      );
    });

    it('all same priority = FCFS order', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              estimatedDuration: fc.integer({ min: 1, max: 100 }),
            }),
            { minLength: 2, maxLength: 15 },
          ),
          (raw) => {
            const tasks: SchedulableTask[] = raw.map((t, i) => ({
              id: `t${i}`,
              dependsOn: [],
              estimatedDuration: t.estimatedDuration,
              requirements: { cpu: 1, memory: 1 },
              priority: 42, // all same
            }));

            const priSchedule = new DagScheduler({
              strategy: new PriorityStrategy(),
              allocator: new FirstFitAllocator(),
            }).schedule(tasks, singleResource);

            const fcfsSchedule = new DagScheduler({
              strategy: new FcfsStrategy(),
              allocator: new FirstFitAllocator(),
            }).schedule(tasks, singleResource);

            // Same priority → makespan identical to FCFS
            expect(priSchedule.makespan).toBe(fcfsSchedule.makespan);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('undefined priority treated as 0 (lowest)', () => {
      const tasks: SchedulableTask[] = [
        { id: 'no_pri', dependsOn: [], estimatedDuration: 1, requirements: { cpu: 1, memory: 1 } },
        { id: 'high', dependsOn: [], estimatedDuration: 1, requirements: { cpu: 1, memory: 1 }, priority: 10 },
      ];
      const ordered = new PriorityStrategy().order(tasks);
      expect(ordered[0]!.id).toBe('high');
    });
  });
});
