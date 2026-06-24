import { describe, it, expect } from 'vitest';
import { ConcurrencyMap } from '../../../src/core/scheduler/concurrency-map.ts';
import type { TaskInstance, TaskInstanceId, TaskId, DagRunId } from '../../../src/core/dag/types.ts';

function makeTi(dagRunId: string, taskId: string): TaskInstance {
  return {
    id: `ti_${taskId}_${dagRunId}` as TaskInstanceId,
    taskId: taskId as TaskId,
    dagRunId: dagRunId as DagRunId,
    state: 'RUNNING',
    tryNumber: 0,
    version: 'v1' as any,
  };
}

describe('ConcurrencyMap', () => {
  it('tracks active task counts', () => {
    const tis = [
      makeTi('dr_proj_001_uuid1', 'task_1'),
      makeTi('dr_proj_001_uuid1', 'task_2'),
      makeTi('dr_proj_002_uuid3', 'task_1'),
    ];
    const map = new ConcurrencyMap(tis);
    expect(map.dagActiveCount('proj')).toBe(3);
    expect(map.taskActiveCount('proj', 'task_1')).toBe(2);
    expect(map.taskActiveCount('proj', 'task_2')).toBe(1);
    expect(map.dagRunActiveCount('proj', 'dr_proj_001_uuid1')).toBe(2);
    expect(map.dagRunActiveCount('proj', 'dr_proj_002_uuid3')).toBe(1);
  });

  it('returns 0 for unknown keys', () => {
    const map = new ConcurrencyMap([]);
    expect(map.dagActiveCount('unknown')).toBe(0);
    expect(map.taskActiveCount('unknown', 't1')).toBe(0);
    expect(map.dagRunActiveCount('unknown', 'dr1')).toBe(0);
  });

  it('handles single task instance', () => {
    const map = new ConcurrencyMap([makeTi('dr_x_001_uuid', 't1')]);
    expect(map.dagActiveCount('x')).toBe(1);
  });
});
