export type { TopoSortResult, DagBuildError } from './interfaces.ts';
export { Dag, buildDag } from './graph.ts';
export { DagOrchestrator } from './orchestrator.ts';
export type { OrchestratedTask, OrchestratedTaskResult, OrchestrationResult } from './orchestrator.ts';

// Unified DAG scheduling domain types (Airflow × GitHub Actions)
export type {
  DagId, DagRunId, TaskId, TaskInstanceId,
  TriggerRule, OperatorType,
  Task, TaskInstance, DagDef, DagRun, DagRunStatus,
  TaskInstanceState,
  Pool,
  TaskExecutionResult, ITaskExecutor, SchedulerContext,
} from './types.ts';
export {
  createDagId, createDagRunId, createTaskId, createTaskInstanceId,
  DEFAULT_TRIGGER_RULE,
  TERMINAL_TASK_STATES, isTaskTerminal,
  TASK_VALID_TRANSITIONS, isValidTaskTransition,
  openSlots as poolOpenSlots,
} from './types.ts';

// Trigger rule evaluation
export { evaluateTriggerRule } from './trigger-rule.ts';
