import { describe, it, expect } from 'vitest';
import { FcfsStrategy, PriorityStrategy, SjfStrategy, CriticalPathStrategy, HeftTaskPriorityStrategy }
  from '../../../src/core/scheduler/dag/strategies.ts';
import type { SchedulableTask } from '../../../src/core/scheduler/dag/types.ts';

function task(id: string, overrides?: Partial<SchedulableTask>): SchedulableTask {
  return {
    id, name: id, estimatedDuration: 1, status: 'ready' as const,
    nodeId: `n-${id}`, type: 'container' as const, priority: 0,
    dependencies: [], ...overrides,
  };
}

function taskWithDeps(id: string, dependsOn: string[], dur = 1): SchedulableTask {
  return task(id, { dependsOn, estimatedDuration: dur });
}

describe('FcfsStrategy', () => {
  const s = new FcfsStrategy();
  it('name is FCFS', () => expect(s.name).toBe('FCFS'));
  it('preserves input order', () => {
    const tasks = [task('c'), task('a'), task('b')];
    expect(s.order(tasks).map(t => t.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('PriorityStrategy', () => {
  const s = new PriorityStrategy();
  it('sorts by priority descending', () => {
    const tasks = [task('low', { priority: 1 }), task('high', { priority: 10 }), task('mid', { priority: 5 })];
    expect(s.order(tasks).map(t => t.id)).toEqual(['high', 'mid', 'low']);
  });
  it('ties broken by stable sort', () => {
    const tasks = [task('a', { priority: 5 }), task('b', { priority: 5 })];
    expect(s.order(tasks).map(t => t.id)).toEqual(['a', 'b']);
  });
});

describe('SjfStrategy', () => {
  const s = new SjfStrategy();
  it('sorts by estimatedDuration ascending', () => {
    const tasks = [task('long', { estimatedDuration: 100 }), task('short', { estimatedDuration: 1 }), task('mid', { estimatedDuration: 50 })];
    expect(s.order(tasks).map(t => t.id)).toEqual(['short', 'mid', 'long']);
  });
});

describe('CriticalPathStrategy (CPM)', () => {
  it('ranks tasks by critical path length', () => {
    // A(1)→B(1) and A→C(5): B's upward rank = 1, C's = 5, A's = max(1+1, 5+1) = 6
    const tasks: SchedulableTask[] = [
      taskWithDeps('A', [], 1),
      taskWithDeps('B', ['A'], 1),
      taskWithDeps('C', ['A'], 5),
    ];
    const s = new CriticalPathStrategy(tasks);
    // Critical path: A→C (6), B (1) — higher rank first
    const ordered = s.order([tasks[0]!, tasks[1]!, tasks[2]!]);
    // A (rank 6) should be first
    expect(ordered[0]!.id).toBe('A');
  });

  it('task with multiple downstream picks longest path', () => {
    // A → B(dur=10) and A → C(dur=1) → D(dur=1)
    const tasks = [
      taskWithDeps('A', [], 1),
      taskWithDeps('B', ['A'], 10),
      taskWithDeps('C', ['A'], 1),
      taskWithDeps('D', ['C'], 1),
    ];
    const s = new CriticalPathStrategy(tasks);
    const ordered = s.order([tasks[1]!, tasks[2]!, tasks[3]!]);
    // B has rank 10, D has rank 1, C has rank 2
    expect(ordered[0]!.id).toBe('B');
  });

  it('default duration is 1ms for zero-duration tasks', () => {
    const tasks = [taskWithDeps('A', [], 0), taskWithDeps('B', ['A'], 0)];
    const s = new CriticalPathStrategy(tasks);
    const ordered = s.order([tasks[0]!, tasks[1]!]);
    expect(ordered[0]!.id).toBe('A'); // A has higher rank (1+1=2) vs B (1)
  });
});

describe('HeftTaskPriorityStrategy', () => {
  it('behaves same as CPM for homogeneous tasks', () => {
    const tasks = [taskWithDeps('A', [], 1), taskWithDeps('B', ['A'], 10)];
    const cpm = new CriticalPathStrategy(tasks);
    const heft = new HeftTaskPriorityStrategy(tasks);
    expect(heft.order(tasks).map(t => t.id)).toEqual(cpm.order(tasks).map(t => t.id));
  });
});
