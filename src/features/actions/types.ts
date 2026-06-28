// ─── Action system types ───
// Workflow/Job/Step definitions and run-time entities.
// All persisted via IAtomicStore with manual indexes (no D1).

import type { VersionId } from '../../core/brand.ts';

declare const WF_DEF_ID: unique symbol;
declare const WF_RUN_ID: unique symbol;
declare const JOB_RUN_ID: unique symbol;

export type WorkflowDefId = string & { readonly [WF_DEF_ID]: true };
export type WorkflowRunId = string & { readonly [WF_RUN_ID]: true };
export type JobRunId = string & { readonly [JOB_RUN_ID]: true };

export function createWorkflowDefId(raw: string): WorkflowDefId { if (!raw) throw new TypeError('empty'); return raw as WorkflowDefId; }
export function createWorkflowRunId(raw: string): WorkflowRunId { if (!raw) throw new TypeError('empty'); return raw as WorkflowRunId; }
export function createJobRunId(raw: string): JobRunId { if (!raw) throw new TypeError('empty'); return raw as JobRunId; }

// ─── Trigger configuration ───

export interface TriggerConfig {
  readonly push?: { readonly branches?: readonly string[] };
  readonly cron?: string;
  readonly manual?: boolean;
  readonly http?: { readonly signatureSecret?: string };
}

// ─── Container (single) vs ContainerGroup (pod) ───

export interface ActionContainerConfig {
  readonly image: string;
  readonly command?: readonly string[];
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly ports?: readonly { readonly containerPort: number; readonly hostPort?: number; readonly protocol?: 'tcp' | 'udp' }[];
  readonly resources?: { readonly cpu?: number; readonly memory?: number };
  readonly workingDir?: string;
  readonly livenessProbe?: {
    readonly httpGet?: { readonly port: number; readonly path?: string };
    readonly initialDelaySeconds?: number;
    readonly periodSeconds?: number;
  };
}

// ─── Step definitions ───

export interface RunStepDef {
  readonly name?: string;
  readonly id?: string;
  readonly run: string;
  readonly env?: Record<string, string>;
  readonly timeout?: number;
  readonly continueOnError?: boolean;
  readonly shell?: string;
}

export interface UsesStepDef {
  readonly name?: string;
  readonly id?: string;
  readonly uses: string; // "action@version" or "docker.io/library/image:tag"
  readonly with?: Record<string, string>;
  readonly env?: Record<string, string>;
  readonly timeout?: number;
  readonly continueOnError?: boolean;
}

export interface DnsStepDef {
  readonly name?: string;
  readonly id?: string;
  readonly dns: {
    readonly action: 'upsert' | 'delete';
    readonly type: 'A' | 'CNAME' | 'TXT';
    readonly name: string;
    readonly value: string;
    readonly ttl?: number;
    readonly proxied?: boolean;
    readonly zoneId: string;
  };
  readonly timeout?: number;
  readonly continueOnError?: boolean;
}

export type StepDef = RunStepDef | UsesStepDef | DnsStepDef;

// ─── Job definition ───

export interface JobDef {
  readonly name: string;
  readonly runsOn?: string;            // label, e.g. "podman", "linux"
  readonly needs?: readonly string[];  // job names this depends on
  readonly steps: readonly StepDef[];
  readonly env?: Record<string, string>;
  readonly timeout?: number;           // seconds, default 600
  readonly if?: string;                // conditional expression
  // Container: single-container mode
  readonly container?: ActionContainerConfig;
  // Containers: multi-container pod mode
  readonly containers?: readonly (ActionContainerConfig & { readonly name: string })[];
  /** Target compute instance. Resolves provider via IProviderRegistry.resolveContainer(). */
  readonly instanceId?: string;
  /** Region to pass to the provider (e.g. "cn-hangzhou", "local"). */
  readonly region?: string;
  /** Manual approval gate — pause this job until approved. */
  readonly approval?: {
    readonly approvers: readonly string[];
    readonly message?: string;
  };
  /** Dependency cache configuration. */
  readonly cache?: {
    readonly key: string;
    readonly paths: readonly string[];
    readonly scope?: 'branch' | 'job' | 'os';
  };
}

// ─── Workflow definition (YAML-parsed) ───

export interface WorkflowDef {
  readonly id: WorkflowDefId;
  readonly name: string;
  readonly description?: string;
  readonly on: TriggerConfig;
  readonly env?: Record<string, string>;
  readonly jobs: Record<string, JobDef>;
  // ─── Extension fields ───
  /** Organization this workflow belongs to. */
  readonly orgId?: string;
  /** Project this workflow belongs to. */
  readonly projectId?: string;
  /** Owner (user ID) who created this workflow. */
  readonly ownerId?: string;
  /** Arbitrary metadata (pluggable by external systems). */
  readonly metadata?: Record<string, unknown>;
  /** String annotations (label-like, usable for selectors). */
  readonly annotations?: Readonly<Record<string, string>>;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly version: VersionId;
}

// ─── Workflow run (instance) ───

export type WorkflowRunStatus = 'Pending' | 'Running' | 'Success' | 'Failure' | 'Cancelled' | 'TimedOut';

export interface JobRunRef {
  readonly jobName: string;
  readonly jobRunId: JobRunId;
}

export interface WorkflowRun {
  readonly id: WorkflowRunId;
  readonly workflowId: WorkflowDefId;
  readonly status: WorkflowRunStatus;
  readonly trigger: 'manual' | 'cron' | 'http' | 'webhook' | 'shared_link';
  readonly triggerPayload?: unknown;
  readonly env: Record<string, string>;
  readonly jobRunRefs: readonly JobRunRef[];
  /** 触发者 userId（个人仪表盘聚类用）. */
  readonly ownerId?: string;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly error?: string;
  readonly version: VersionId;
}

// ─── Job run (instance) ───

export type JobRunStatus = 'Queued' | 'Running' | 'Success' | 'Failure' | 'Skipped' | 'Cancelled';

export interface StepRun {
  readonly name: string;
  readonly status: JobRunStatus;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly exitCode?: number;
  readonly output?: string;
  readonly error?: string;
}

export interface JobRun {
  readonly id: JobRunId;
  readonly workflowRunId: WorkflowRunId;
  readonly jobName: string;
  readonly status: JobRunStatus;
  /** Provider-assigned resource ID (backward compat). */
  readonly sandboxId?: string;
  /** PodService-assigned PodId for lifecycle tracking (v3 unified path). */
  readonly podId?: string;
  readonly attempts: number;
  readonly stepRuns: readonly StepRun[];
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly error?: string;
  readonly version: VersionId;
}

// ─── API input types ───

export interface CreateWorkflowInput {
  readonly name: string;
  readonly description?: string;
  readonly on: TriggerConfig;
  readonly env?: Record<string, string>;
  readonly jobs: Record<string, JobDef>;
}

export interface UpdateWorkflowInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly on?: TriggerConfig;
  readonly env?: Record<string, string>;
  readonly jobs?: Record<string, JobDef>;
}

export interface TriggerWorkflowInput {
  readonly workflowId: string;
  readonly inputs?: Record<string, string>;
  readonly payload?: unknown;
}

// ─── Storage index keys ───

export const IDX_WORKFLOW_IDS = 'action:workflow:ids';
export const IDX_WORKFLOW_RUN_IDS = 'action:workflow-run:ids';
export const IDX_JOB_RUN_IDS = 'action:job-run:ids';
export const PFX_WORKFLOW_DEF = 'workflow-def:';
export const PFX_WORKFLOW_RUN = 'workflow-run:';
export const PFX_JOB_RUN = 'job-run:';
