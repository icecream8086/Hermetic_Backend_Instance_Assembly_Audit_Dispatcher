import { describe, it, expect } from 'vitest';
import { DagOrchestrator } from '../../../src/core/dag/orchestrator.ts';
import type { OrchestratedTask } from '../../../src/core/dag/orchestrator.ts';

// ─── Test task type ───

interface TestTask extends OrchestratedTask {
  readonly id: string;
  readonly dependsOn: readonly string[];
  readonly label: string;
  readonly shouldFail?: boolean | undefined;
}

function task(id: string, dependsOn: string[] = [], shouldFail?: boolean): TestTask {
  return { id, dependsOn, label: id, shouldFail };
}

// ─── Tests ───

describe('DagOrchestrator', () => {
  const orchestrator = new DagOrchestrator<TestTask>();

  it('executes zero tasks successfully', async () => {
    const result = await orchestrator.execute([], async () => {});
    expect(result.success).toBe(true);
    expect(result.results).toEqual([]);
  });

  it('executes a single task with no dependencies', async () => {
    const executed: string[] = [];
    const result = await orchestrator.execute([task('a')], async (t) => {
      executed.push(t.id);
    });
    expect(result.success).toBe(true);
    expect(executed).toEqual(['a']);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.success).toBe(true);
  });

  it('executes tasks in dependency order (sequential chain)', async () => {
    const executed: string[] = [];
    const tasks = [task('c', ['b']), task('a'), task('b', ['a'])];
    const result = await orchestrator.execute(tasks, async (t) => {
      executed.push(t.id);
    });
    expect(result.success).toBe(true);
    // a (no deps) → b (depends on a) → c (depends on b)
    expect(executed.indexOf('a')).toBeLessThan(executed.indexOf('b'));
    expect(executed.indexOf('b')).toBeLessThan(executed.indexOf('c'));
    expect(result.results).toHaveLength(3);
    expect(result.results.every(r => r.success)).toBe(true);
  });

  it('executes independent tasks concurrently (single batch)', async () => {
    const executed: string[] = [];
    const tasks = [task('a'), task('b'), task('c')];
    const result = await orchestrator.execute(tasks, async (t) => {
      executed.push(t.id);
    });
    expect(result.success).toBe(true);
    // All independent — all should execute
    expect(executed.sort()).toEqual(['a', 'b', 'c']);
  });

  it('handles diamond-shaped DAG', async () => {
    const executed: string[] = [];
    //    a
    //   / \
    //  b   c
    //   \ /
    //    d
    const tasks = [
      task('a'),
      task('b', ['a']),
      task('c', ['a']),
      task('d', ['b', 'c']),
    ];
    const result = await orchestrator.execute(tasks, async (t) => {
      executed.push(t.id);
    });
    expect(result.success).toBe(true);
    expect(executed.indexOf('a')).toBe(0); // a must be first
    expect(executed.indexOf('d')).toBe(3); // d must be last
    expect([...executed].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('reports cycle detection', async () => {
    const tasks = [
      task('a', ['b']),
      task('b', ['c']),
      task('c', ['a']), // cycle!
    ];
    const result = await orchestrator.execute(tasks, async () => {});
    expect(result.success).toBe(false);
  });

  it('skips dependents when a dependency fails', async () => {
    const executed: string[] = [];
    // a → b (fails) → c
    const tasks = [
      task('a'),
      task('b', ['a'], true),
      task('c', ['b']),
    ];
    const result = await orchestrator.execute(tasks, async (t) => {
      executed.push(t.id);
      if (t.shouldFail) throw new Error('intentional failure');
    });
    expect(result.success).toBe(false);
    expect(executed).toContain('a');
    expect(executed).toContain('b');
    // c should NOT execute (its dependency b failed)
    expect(executed).not.toContain('c');
    expect(result.results.find(r => r.id === 'a')!.success).toBe(true);
    expect(result.results.find(r => r.id === 'b')!.success).toBe(false);
    expect(result.results.find(r => r.id === 'c')!.success).toBe(false);
    expect(result.results.find(r => r.id === 'c')!.error).toMatch(/dependency/i);
  });

  it('executes remaining batch tasks when one in the batch fails', async () => {
    // a (fails) and b (independent, succeeds) run in same batch
    const executed: string[] = [];
    const tasks = [
      task('a', [], true),
      task('b'),
    ];
    const result = await orchestrator.execute(tasks, async (t) => {
      executed.push(t.id);
      if (t.shouldFail) throw new Error('intentional failure');
    });
    // Both should have been attempted
    expect(executed.sort()).toEqual(['a', 'b']);
    expect(result.results.find(r => r.id === 'a')!.success).toBe(false);
    expect(result.results.find(r => r.id === 'b')!.success).toBe(true);
  });
});
