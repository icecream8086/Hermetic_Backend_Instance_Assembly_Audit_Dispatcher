import { describe, it, expect } from 'vitest';
import {
  FcfsStrategy, PriorityStrategy, SjfStrategy,
  CriticalPathStrategy, HeftTaskPriorityStrategy,
  FirstFitAllocator, LeastRequestedAllocator, HeftAllocator,
  computeUpwardRanks,
} from '../../../src/core/scheduler/dag/strategies.ts';
import type { SchedulableTask, ResourceSnapshot, ResourceVector } from '../../../src/core/scheduler/dag/types.ts';

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

// ═══════════════════════════════════════════════════════════════
// 分配器 + CPM rank 测试 (ISSUE-00020 / ISSUE-00071)
// ═══════════════════════════════════════════════════════════════

function resNode(id: string, cpu: number, memory: number) {
  return { id, capacity: { cpu, memory }, labels: {} };
}
function snapshot(nodeId: string, cpu: number, memory: number, gpu?: number): ResourceSnapshot {
  return {
    node: resNode(nodeId, cpu * 10, memory * 1024),
    available: { cpu, memory, ...(gpu !== undefined ? { gpu } : {}) },
    availableAt: 0,
  };
}
function reqTask(id: string, cpu: number, memory: number, dur = 1, gpu?: number): SchedulableTask {
  return {
    id, dependsOn: [], estimatedDuration: dur,
    requirements: { cpu, memory, ...(gpu !== undefined ? { gpu } : {}) },
  };
}

describe('FirstFitAllocator', () => {
  const ff = new FirstFitAllocator();
  it('selects first resource that fits', () => {
    expect(ff.select(reqTask('t', 2, 512), [
      snapshot('r1', 1, 1024), snapshot('r2', 4, 256), snapshot('r3', 4, 1024),
    ])).toBe('r3');
  });
  it('returns null when nothing fits', () => {
    expect(ff.select(reqTask('t', 100, 999999), [snapshot('r1', 1, 1024)])).toBeNull();
  });
  it('GPU demand needs GPU available', () => {
    expect(ff.select(reqTask('t', 1, 512, 1, 1), [snapshot('r1', 8, 4096)])).toBeNull();
    expect(ff.select(reqTask('t', 1, 512, 1, 1), [snapshot('r1', 8, 4096, 2)])).toBe('r1');
  });
  it('empty list returns null', () => {
    expect(ff.select(reqTask('t', 1, 512), [])).toBeNull();
  });
  it('gpu:0 边界: explicit zero GPU does not require GPU capacity', () => {
    expect(ff.select(reqTask('t', 1, 512, 1, 0), [snapshot('r1', 8, 4096)])).toBe('r1');
  });
});

describe('LeastRequestedAllocator', () => {
  const lr = new LeastRequestedAllocator();
  it('selects resource with lowest utilization (most available relative to capacity)', () => {
    // 'busy': avail=8/80=0.1 cpu util, 8192/(8192*1024)=0.001 mem util → avg 0.0505
    // 'idle': avail=4/80=0.05 cpu util, 4096/(4096*1024)=0.001 mem util → avg 0.0255
    // Fix: use different capacity ratios so utilization is NOT identical
    const idle: ResourceSnapshot = {
      node: { id: 'idle', capacity: { cpu: 80, memory: 4096 * 1024 }, labels: {} },
      available: { cpu: 4, memory: 4096 },
      availableAt: 0,
    };
    const busy: ResourceSnapshot = {
      node: { id: 'busy', capacity: { cpu: 10, memory: 1024 * 1024 }, labels: {} },
      available: { cpu: 1, memory: 1024 },
      availableAt: 0,
    };
    // idle has lower utilization → should be selected
    expect(lr.select(reqTask('t', 1, 512), [busy, idle])).toBe('idle');
  });
  it('returns null when nothing fits', () => {
    expect(lr.select(reqTask('t', 100, 999999), [snapshot('r1', 1, 1024)])).toBeNull();
  });
  it('GPU: ignores node without enough GPU', () => {
    const t = reqTask('t', 1, 512, 1, 1);
    const noGpu = { ...snapshot('nogpu', 8, 4096), available: { cpu: 8, memory: 4096 } as ResourceVector };
    const hasGpu = { ...snapshot('hasgpu', 8, 4096), available: { cpu: 8, memory: 4096, gpu: 2 } as ResourceVector };
    expect(lr.select(t, [noGpu, hasGpu])).toBe('hasgpu');
  });
});

describe('HeftAllocator', () => {
  const h = new HeftAllocator();
  it('selects resource with earliest finish time', () => {
    expect(h.select(reqTask('t', 1, 512, 10), [
      { ...snapshot('fast', 8, 4096), availableAt: 0 },
      { ...snapshot('slow', 8, 4096), availableAt: 20 },
    ])).toBe('fast');
  });
  it('returns null when nothing fits', () => {
    expect(h.select(reqTask('t', 100, 999999), [snapshot('r1', 1, 1024)])).toBeNull();
  });
  it('GPU: ignores node without enough GPU', () => {
    const t = reqTask('t', 1, 512, 10, 1);
    const noGpu = { ...snapshot('nogpu', 8, 4096), available: { cpu: 8, memory: 4096 } as ResourceVector };
    const hasGpu = { ...snapshot('hasgpu', 8, 4096), available: { cpu: 8, memory: 4096, gpu: 2 } as ResourceVector };
    expect(h.select(t, [noGpu, hasGpu])).toBe('hasgpu');
  });
  it('gpu:0 边界: demand 明确为 0 时不要求 GPU', () => {
    expect(h.select(reqTask('t', 1, 512, 1, 0), [snapshot('r1', 8, 4096)])).toBe('r1');
  });
});

describe('computeUpwardRanks', () => {
  it('sink task rank = estimatedDuration', () => {
    const tasks: SchedulableTask[] = [
      { id: 'A', dependsOn: [], estimatedDuration: 5, requirements: { cpu: 1, memory: 128 } },
    ];
    expect(computeUpwardRanks(tasks).get('A')).toBe(5);
  });
  it('linear chain: ranks propagate upward', () => {
    // A depends on B, B depends on C. successors: A:[], B:[A], C:[B]
    const tasks: SchedulableTask[] = [
      { id: 'A', dependsOn: ['B'], estimatedDuration: 1, requirements: { cpu: 1, memory: 128 } },
      { id: 'B', dependsOn: ['C'], estimatedDuration: 2, requirements: { cpu: 1, memory: 128 } },
      { id: 'C', dependsOn: [],      estimatedDuration: 3, requirements: { cpu: 1, memory: 128 } },
    ];
    const ranks = computeUpwardRanks(tasks);
    expect(ranks.get('A')).toBe(1);  // leaf
    expect(ranks.get('B')).toBe(3);  // 2 + 1
    expect(ranks.get('C')).toBe(6);  // 3 + 3
  });
  it('diamond DAG: rank picks longest child path', () => {
    const tasks: SchedulableTask[] = [
      { id: 'A', dependsOn: ['B', 'C'], estimatedDuration: 1, requirements: { cpu: 1, memory: 128 } },
      { id: 'B', dependsOn: ['D'],      estimatedDuration: 1, requirements: { cpu: 1, memory: 128 } },
      { id: 'C', dependsOn: ['D'],      estimatedDuration: 5, requirements: { cpu: 1, memory: 128 } },
      { id: 'D', dependsOn: [],          estimatedDuration: 2, requirements: { cpu: 1, memory: 128 } },
    ];
    const ranks = computeUpwardRanks(tasks);
    expect(ranks.get('A')).toBe(1);
    expect(ranks.get('B')).toBe(2);
    expect(ranks.get('C')).toBe(6);  // longer path
    expect(ranks.get('D')).toBe(8);  // 2 + max(2,6)
  });
  it('independent tasks each get own rank', () => {
    const tasks: SchedulableTask[] = [
      { id: 'A', dependsOn: [], estimatedDuration: 3, requirements: { cpu: 1, memory: 128 } },
      { id: 'B', dependsOn: [], estimatedDuration: 7, requirements: { cpu: 1, memory: 128 } },
    ];
    const ranks = computeUpwardRanks(tasks);
    expect(ranks.get('A')).toBe(3);
    expect(ranks.get('B')).toBe(7);
  });
});
