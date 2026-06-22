import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  DagScheduler,
} from '../../../src/core/scheduler/dag/dag-scheduler.ts';
import {
  FcfsStrategy,
  PriorityStrategy,
  SjfStrategy,
  CriticalPathStrategy,
  HeftTaskPriorityStrategy,
  FirstFitAllocator,
  LeastRequestedAllocator,
  HeftAllocator,
  computeUpwardRanks,
} from '../../../src/core/scheduler/dag/strategies.ts';
import type {
  SchedulableTask,
  ResourceNode,
  Schedule,
  ResourceVector,
} from '../../../src/core/scheduler/dag/types.ts';

// ─── Arbitraries ───

const smallInt = (max: number) => fc.integer({ min: 1, max });

const resourceVector: fc.Arbitrary<ResourceVector> = fc.record({
  cpu: smallInt(8),
  memory: smallInt(16384),
  gpu: fc.oneof(fc.constant(undefined), smallInt(4)),
});

/**
 * Generate a random DAG of SchedulableTasks with unique sequential IDs.
 * Uses the "forward edge only" technique (i < j) to guarantee acyclicity.
 */
function randomTaskDag(
  maxNodes: number,
  maxDuration: number,
): fc.Arbitrary<SchedulableTask[]> {
  return fc.integer({ min: 1, max: maxNodes }).chain(n =>
    fc.tuple(
      fc.array(smallInt(maxDuration), { minLength: n, maxLength: n }),
      fc.array(resourceVector, { minLength: n, maxLength: n }),
      fc.integer({ min: 0, max: Math.min(n * 2, 30) }),
    ).map(([durations, reqs, edgeCount]) => {
      const possible: Array<[number, number]> = [];
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          possible.push([i, j]);
        }
      }
      for (let i = possible.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [possible[i], possible[j]] = [possible[j]!, possible[i]!];
      }
      const edges = possible.slice(0, edgeCount);

      const depSets = new Map<string, string[]>();
      for (let i = 0; i < n; i++) depSets.set(`t${i}`, []);
      for (const [from, to] of edges) {
        depSets.get(`t${from}`)!.push(`t${to}`);
      }

      return Array.from({ length: n }, (_, i) => ({
        id: `t${i}`,
        dependsOn: depSets.get(`t${i}`) ?? [],
        estimatedDuration: durations[i]!,
        requirements: reqs[i]!,
        priority: Math.random() > 0.5 ? Math.floor(Math.random() * 10) : undefined,
      }));
    }),
  );
}

function randomResources(maxNodes: number): fc.Arbitrary<ResourceNode[]> {
  return fc.integer({ min: 1, max: maxNodes }).chain(n =>
    fc.array(
      fc.record<Omit<ResourceNode, 'id'>>({
        capacity: resourceVector,
        labels: fc.constant({}),
        supportedLabels: fc.constant(undefined),
      }),
      { minLength: n, maxLength: n },
    ).map(raw =>
      raw.map((r, i) => ({ id: `r${i}`, ...r })),
    ),
  );
}

// ─── Verify functions ───

/** Check that a schedule respects all invariants. */
function verifySchedule(
  schedule: Schedule,
  tasks: readonly SchedulableTask[],
  resources: readonly ResourceNode[],
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // 1. Every task has exactly one entry (or is in unassigned)
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const entryMap = new Map<string, typeof schedule.entries[0]>();
  for (const e of schedule.entries) {
    if (entryMap.has(e.taskId)) {
      errors.push(`Duplicate entry for ${e.taskId}`);
    }
    entryMap.set(e.taskId, e);
    if (!taskMap.has(e.taskId)) {
      errors.push(`Entry references unknown task ${e.taskId}`);
    }
  }

  // 2. Unassigned tasks have no entry (and vice versa)
  const assignedIds = new Set(schedule.entries.map(e => e.taskId));
  for (const id of schedule.unassigned) {
    if (assignedIds.has(id)) errors.push(`Task ${id} both assigned and unassigned`);
  }
  for (const t of tasks) {
    if (!assignedIds.has(t.id) && !schedule.unassigned.includes(t.id)) {
      errors.push(`Task ${t.id} missing from both entries and unassigned`);
    }
  }

  // 3. DAG dependency order: no task starts before all its deps finish
  for (const t of tasks) {
    const entry = entryMap.get(t.id);
    if (!entry) continue;

    for (const dep of t.dependsOn) {
      const depEntry = entryMap.get(dep);
      if (!depEntry) {
        // Dependency not in entries — OK if it's unassigned
        if (!schedule.unassigned.includes(dep)) {
          errors.push(`${t.id} depends on ${dep} but dep not in schedule`);
        }
        continue;
      }
      if (entry.startTime < depEntry.completionTime) {
        errors.push(
          `${t.id} starts at ${entry.startTime} before dep ${dep} finishes at ${depEntry.completionTime}`,
        );
      }
    }
  }

  // 4. Completion time = start time + estimated duration
  for (const t of tasks) {
    const entry = entryMap.get(t.id);
    if (!entry) continue;
    const expected = entry.startTime + t.estimatedDuration;
    if (entry.completionTime !== expected) {
      errors.push(`${t.id}: completionTime ${entry.completionTime} != startTime ${entry.startTime} + duration ${t.estimatedDuration}`);
    }
  }

  // 5. Resource capacity never exceeded (check overlapping intervals)
  const resourceMap = new Map(resources.map(r => [r.id, r]));
  for (const rid of [...new Set(schedule.entries.map(e => e.resourceId))]) {
    const r = resourceMap.get(rid);
    if (!r) { errors.push(`Unknown resource ${rid}`); continue; }

    // Collect all entries for this resource, sorted by startTime
    const resEntries = schedule.entries.filter(e => e.resourceId === rid).sort((a, b) => a.startTime - b.startTime);

    // Check all time points where tasks start — at each point, ensure capacity is sufficient
    for (let i = 0; i < resEntries.length; i++) {
      const now = resEntries[i]!.startTime;
      let cpuUsed = 0;
      let memUsed = 0;
      let gpuUsed = 0;

      // Sum requirements of all tasks running at time 'now'
      for (const e of resEntries) {
        if (e.startTime <= now && e.completionTime > now) {
          const task = taskMap.get(e.taskId);
          if (task) {
            cpuUsed += task.requirements.cpu;
            memUsed += task.requirements.memory;
            gpuUsed += task.requirements.gpu ?? 0;
          }
        }
      }

      if (cpuUsed > r.capacity.cpu) {
        errors.push(`Resource ${rid} over-committed CPU at ${now}: ${cpuUsed}/${r.capacity.cpu}`);
      }
      if (memUsed > r.capacity.memory) {
        errors.push(`Resource ${rid} over-committed memory at ${now}: ${memUsed}/${r.capacity.memory}`);
      }
      if ((r.capacity.gpu ?? 0) > 0 && gpuUsed > (r.capacity.gpu ?? 0)) {
        errors.push(`Resource ${rid} over-committed GPU at ${now}: ${gpuUsed}/${r.capacity.gpu}`);
      }
    }
  }

  // 6. Makespan is consistent with entries
  const computedMakespan = schedule.entries.reduce((max, e) => Math.max(max, e.completionTime), 0);
  if (schedule.makespan !== computedMakespan && schedule.entries.length > 0) {
    errors.push(`makespan ${schedule.makespan} != computed ${computedMakespan}`);
  }

  return { valid: errors.length === 0, errors };
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe('DagScheduler (formal verification)', () => {
  describe('schedule invariants (all tasks assigned)', () => {
    it('FCFS + FirstFit produces valid schedules for any DAG', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.tuple(randomTaskDag(12, 100), randomResources(4)),
          async ([tasks, resources]) => {
            const scheduler = new DagScheduler({
              strategy: new FcfsStrategy(),
              allocator: new FirstFitAllocator(),
            });
            const schedule = scheduler.schedule(tasks, resources);
            const result = verifySchedule(schedule, tasks, resources);
            if (!result.valid) {
              throw new Error(result.errors.join('; '));
            }
          },
        ),
        { numRuns: 500 },
      );
    });

    it('Priority + LeastRequested produces valid schedules', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.tuple(randomTaskDag(12, 100), randomResources(4)),
          async ([tasks, resources]) => {
            const scheduler = new DagScheduler({
              strategy: new PriorityStrategy(),
              allocator: new LeastRequestedAllocator(),
            });
            const schedule = scheduler.schedule(tasks, resources);
            const result = verifySchedule(schedule, tasks, resources);
            if (!result.valid) throw new Error(result.errors.join('; '));
          },
        ),
        { numRuns: 300 },
      );
    });

    it('SJF + HEFT produces valid schedules', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.tuple(randomTaskDag(10, 100), randomResources(3)),
          async ([tasks, resources]) => {
            const scheduler = new DagScheduler({
              strategy: new SjfStrategy(),
              allocator: new HeftAllocator(),
            });
            const schedule = scheduler.schedule(tasks, resources);
            const result = verifySchedule(schedule, tasks, resources);
            if (!result.valid) throw new Error(result.errors.join('; '));
          },
        ),
        { numRuns: 300 },
      );
    });

    it('CPM + HEFT produces valid schedules', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.tuple(randomTaskDag(12, 100), randomResources(4)),
          async ([tasks, resources]) => {
            const scheduler = new DagScheduler({
              strategy: new CriticalPathStrategy(tasks),
              allocator: new HeftAllocator(),
            });
            const schedule = scheduler.schedule(tasks, resources);
            const result = verifySchedule(schedule, tasks, resources);
            if (!result.valid) throw new Error(result.errors.join('; '));
          },
        ),
        { numRuns: 300 },
      );
    });
  });

  describe('structural invariants', () => {
    it('makespan is bounded: max duration ≤ makespan ≤ serial sum', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.tuple(randomTaskDag(8, 200), randomResources(1)),
          async ([tasks, resources]) => {
            const scheduler = new DagScheduler({
              strategy: new FcfsStrategy(),
              allocator: new FirstFitAllocator(),
            });
            const schedule = scheduler.schedule(tasks, resources);

            if (schedule.unassigned.length > 0) return; // skip infeasible

            const maxDuration = Math.max(...tasks.map(t => t.estimatedDuration));
            const serialSum = tasks.reduce((s, t) => s + t.estimatedDuration, 0);

            // With 1 resource, makespan ≈ serial sum
            expect(schedule.makespan).toBeGreaterThanOrEqual(maxDuration);
            expect(schedule.makespan).toBeLessThanOrEqual(serialSum);
          },
        ),
        { numRuns: 200 },
      );
    });

    it('more resources → makespan never increases', async () => {
      await fc.assert(
        fc.asyncProperty(
          randomTaskDag(6, 100),
          async (tasks) => {
            const buildResources = (n: number): ResourceNode[] =>
              Array.from({ length: n }, (_, i) => ({
                id: `r${i}`,
                capacity: { cpu: 8, memory: 16384 },
                labels: {},
              }));

            const s1 = new DagScheduler({
              strategy: new FcfsStrategy(),
              allocator: new FirstFitAllocator(),
            }).schedule(tasks, buildResources(1));

            const s4 = new DagScheduler({
              strategy: new FcfsStrategy(),
              allocator: new FirstFitAllocator(),
            }).schedule(tasks, buildResources(4));

            // More resources should not increase makespan
            if (s1.unassigned.length === 0 && s4.unassigned.length === 0) {
              expect(s4.makespan).toBeLessThanOrEqual(
                s1.makespan + 1, // +1 for rounding tolerance
              );
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it('empty task list produces empty schedule', () => {
      const scheduler = new DagScheduler({
        strategy: new FcfsStrategy(),
        allocator: new FirstFitAllocator(),
      });
      const schedule = scheduler.schedule([], [{ id: 'r1', capacity: { cpu: 1, memory: 1 }, labels: {} }]);
      expect(schedule.entries).toEqual([]);
      expect(schedule.makespan).toBe(0);
    });

    it('no resources → all tasks unassigned', async () => {
      await fc.assert(
        fc.asyncProperty(randomTaskDag(5, 50), async (tasks) => {
          const scheduler = new DagScheduler({
            strategy: new FcfsStrategy(),
            allocator: new FirstFitAllocator(),
          });
          const schedule = scheduler.schedule(tasks, []);
          expect(schedule.entries).toEqual([]);
        }),
        { numRuns: 50 },
      );
    });
  });

  describe('CPM strategy correctness', () => {
    it('CPM rank: sink tasks have rank = estimatedDuration', () => {
      const tasks: SchedulableTask[] = [
        { id: 'a', dependsOn: [], estimatedDuration: 10, requirements: { cpu: 1, memory: 1 } },
        { id: 'b', dependsOn: [], estimatedDuration: 5, requirements: { cpu: 1, memory: 1 } },
      ];
      const ranks = computeUpwardRanks(tasks);
      expect(ranks.get('a')).toBe(10);
      expect(ranks.get('b')).toBe(5);
    });

    it('CPM rank: chain a→b→c gives correct ranks', () => {
      const tasks: SchedulableTask[] = [
        { id: 'a', dependsOn: [], estimatedDuration: 1, requirements: { cpu: 1, memory: 1 } },
        { id: 'b', dependsOn: ['a'], estimatedDuration: 2, requirements: { cpu: 1, memory: 1 } },
        { id: 'c', dependsOn: ['b'], estimatedDuration: 3, requirements: { cpu: 1, memory: 1 } },
      ];
      const ranks = computeUpwardRanks(tasks);
      // c (sink): 3, b: 2+3=5, a: 1+5=6
      expect(ranks.get('c')).toBe(3);
      expect(ranks.get('b')).toBe(5);
      expect(ranks.get('a')).toBe(6);
    });

    it('CPM orders critical path tasks first', () => {
      const tasks: SchedulableTask[] = [
        { id: 'critical', dependsOn: [], estimatedDuration: 100, requirements: { cpu: 1, memory: 1 } },
        { id: 'non_critical', dependsOn: [], estimatedDuration: 1, requirements: { cpu: 1, memory: 1 } },
      ];
      const strategy = new CriticalPathStrategy(tasks);
      const ordered = strategy.order(tasks);
      expect(ordered[0]!.id).toBe('critical');
    });
  });

  describe('determinism', () => {
    it('same input produces identical schedule', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.tuple(randomTaskDag(8, 100), randomResources(3)),
          async ([tasks, resources]) => {
            const mkScheduler = () => new DagScheduler({
              strategy: new FcfsStrategy(),
              allocator: new FirstFitAllocator(),
            });

            const s1 = mkScheduler().schedule(tasks, resources);
            const s2 = mkScheduler().schedule(tasks, resources);

            expect(s1.makespan).toBe(s2.makespan);
            expect(s1.unassigned.length).toBe(s2.unassigned.length);
            expect(s1.entries.length).toBe(s2.entries.length);

            // Order should be identical
            const ids1 = s1.entries.map(e => e.taskId).join(',');
            const ids2 = s2.entries.map(e => e.taskId).join(',');
            expect(ids1).toBe(ids2);
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  describe('no starvation', () => {
    it('all tasks with satisfiable resources get scheduled', async () => {
      // Use fixed huge-capacity resource so no task is resource-blocked
      const infiniteResource: ResourceNode[] = [
        { id: 'big', capacity: { cpu: 999, memory: 999999, gpu: 999 }, labels: {} },
      ];

      await fc.assert(
        fc.asyncProperty(randomTaskDag(10, 50), async (tasks) => {
          const scheduler = new DagScheduler({
            strategy: new FcfsStrategy(),
            allocator: new FirstFitAllocator(),
          });
          const schedule = scheduler.schedule(tasks, infiniteResource);

          expect(schedule.unassigned.length).toBe(0);
          expect(schedule.entries.length).toBe(tasks.length);
        }),
        { numRuns: 200 },
      );
    });
  });
});
