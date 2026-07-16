import type { DagDef, DagId, Task, DagRun } from '../../core/dag/types.ts';
import { createDagId, createTaskId, createDagRunId, DEFAULT_TRIGGER_RULE } from '../../core/dag/types.ts';
import type { WorkflowDef, JobDef } from './types.ts';
import { generateVersionId } from '../../core/brand.ts';

/**
 * Convert a GitHub Actions–style WorkflowDef into an Airflow-style DagDef.
 *
 * Mapping:
 *   WorkflowDef         → DagDef
 *   JobDef              → Task (operatorType = 'container' | 'dns')
 *   JobDef.needs        → Task.dependsOn
 *   WorkflowRun (later) → DagRun
 *   JobRun (later)      → TaskInstance
 *
 * Each JobDef becomes a single Task. Steps within the job are executed
 * sequentially by the JobOperator (ITaskExecutor implementation).
 */

export interface BuildDagOptions {
  /** Override the DAG id (defaults to wf_<workflowDef.id>). */
  readonly dagId?: DagId;
  /** Extra metadata to merge into Task configs. */
  readonly metadata?: Record<string, unknown>;
}

export function buildDagFromWorkflow(
  wf: WorkflowDef,
  options: BuildDagOptions = {},
): { dag: DagDef; taskMap: Map<string, Task> } {
  const dagId = options.dagId ?? createDagId(`wf_${wf.id}`);
  const now = Date.now();

  const tasks: Task[] = [];
  const taskMap = new Map<string, Task>();

  for (const [jobName, jobDef] of Object.entries(wf.jobs)) {
    const task = jobToTask(jobName, jobDef, wf.env, options.metadata);
    tasks.push(task);
    taskMap.set(jobName, task);
  }

  const dag: DagDef = {
    id: dagId,
    name: wf.name,
    ...(wf.description ? { description: wf.description } : {}),
    tasks,
    maxActiveTasks: 16,
    maxActiveRuns: 5,
    createdAt: now,
    updatedAt: now,
    version: generateVersionId(),
  };

  return { dag, taskMap };
}

function jobToTask(
  jobName: string,
  jobDef: JobDef,
  wfEnv: Record<string, string> = {},
  metadata?: Record<string, unknown>,
): Task {
  const taskId = createTaskId(`task_${jobName}`);

  const isApproval = !!jobDef.approval?.approvers?.length;
  return {
    id: taskId,
    name: jobName,
    operatorType: isApproval ? 'approval-sensor' : 'pod',
    config: {
      jobName,
      needs: jobDef.needs ?? [],
      steps: jobDef.steps,
      env: { ...wfEnv, ...jobDef.env },
      timeout: jobDef.timeout,
      container: jobDef.container,
      containers: jobDef.containers,
      instanceId: jobDef.instanceId,
      region: jobDef.region,
      approval: jobDef.approval,
      cache: jobDef.cache,
      ...metadata,
    },
    dependsOn: (jobDef.needs ?? []).map(n => createTaskId(`task_${n}`)),
    triggerRule: DEFAULT_TRIGGER_RULE,
    retries: 0,
    retryDelayMs: 30_000,
    ...(jobDef.timeout ? { timeoutMs: jobDef.timeout * 1000 } : {}),
  };
}

/** Create a DagRun from a WorkflowRun trigger. */
export function createDagRunFromTrigger(
  dagId: DagId,
  trigger: DagRun['trigger'],
  triggerPayload?: unknown,
  env?: Record<string, string>,
  ownerId?: string,
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- DagRun has 12 fields, Omit avoids duplicating the type minus version
): Omit<DagRun, 'version'> {
  return {
    id: createDagRunId(`dr_${dagId}_${String(Date.now())}_${crypto.randomUUID()}`),
    dagId,
    status: 'QUEUED',
    executionDate: Date.now(),
    trigger,
    triggerPayload,
    env: env ?? {},
    ...(ownerId ? { ownerId } : {}),
  };
}
