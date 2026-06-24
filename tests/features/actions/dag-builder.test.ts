import { describe, it, expect } from 'vitest';
import {
  buildDagFromWorkflow,
  createDagRunFromTrigger,
} from '../../../src/features/actions/dag-builder.ts';
import type { WorkflowDef } from '../../../src/features/actions/types.ts';
import { DEFAULT_TRIGGER_RULE } from '../../../src/core/dag/types.ts';

function dummyWorkflow(overrides?: Partial<WorkflowDef>): WorkflowDef {
  return {
    id: 'wf_test' as any,
    name: 'test-wf',
    on: { manual: true },
    jobs: {
      build: {
        name: 'build',
        steps: [{ run: 'echo hello' }],
        container: { image: 'node:20' },
      },
      deploy: {
        name: 'deploy',
        needs: ['build'],
        steps: [{ run: 'echo deploy' }],
        container: { image: 'node:20' },
      },
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    version: 'v1' as any,
    ...overrides,
  };
}

describe('buildDagFromWorkflow', () => {
  it('converts WorkflowDef to DagDef with correct task count', () => {
    const wf = dummyWorkflow();
    const { dag, taskMap } = buildDagFromWorkflow(wf);

    expect(dag.tasks).toHaveLength(2);
    expect(taskMap.size).toBe(2);
    expect(dag.name).toBe('test-wf');
  });

  it('tasks have correct operatorType', () => {
    const { dag } = buildDagFromWorkflow(dummyWorkflow());
    for (const task of dag.tasks) {
      expect(task.operatorType).toBe('sandbox');
    }
  });

  it('task dependsOn matches job needs', () => {
    const { dag } = buildDagFromWorkflow(dummyWorkflow());
    const deploy = dag.tasks.find(t => t.name === 'deploy');
    expect(deploy).toBeDefined();
    expect(deploy!.dependsOn).toHaveLength(1);
    expect(deploy!.dependsOn[0]).toContain('build');
  });

  it('task without needs has empty dependsOn', () => {
    const { dag } = buildDagFromWorkflow(dummyWorkflow());
    const build = dag.tasks.find(t => t.name === 'build');
    expect(build).toBeDefined();
    expect(build!.dependsOn).toEqual([]);
  });

  it('tasks have default trigger rule', () => {
    const { dag } = buildDagFromWorkflow(dummyWorkflow());
    for (const task of dag.tasks) {
      expect(task.triggerRule).toBe(DEFAULT_TRIGGER_RULE);
    }
  });

  it('task config contains job metadata', () => {
    const { dag } = buildDagFromWorkflow(dummyWorkflow());
    const build = dag.tasks.find(t => t.name === 'build')!;
    expect(build.config).toHaveProperty('steps');
    expect(build.config).toHaveProperty('container');
    expect(build.config).toHaveProperty('jobName', 'build');
  });

  it('accepts custom dagId', () => {
    const { dag } = buildDagFromWorkflow(dummyWorkflow(), { dagId: 'custom_id' as any });
    expect(dag.id).toBe('custom_id');
  });
});

describe('createDagRunFromTrigger', () => {
  it('creates a QUEUED DagRun', () => {
    const run = createDagRunFromTrigger('dag_test' as any, 'manual', undefined, {}, 'user1');
    expect(run.status).toBe('QUEUED');
    expect(run.trigger).toBe('manual');
    expect(run.dagId).toBe('dag_test');
    expect(run.ownerId).toBe('user1');
    expect(run.id).toContain('dr_dag_test_');
  });
});
