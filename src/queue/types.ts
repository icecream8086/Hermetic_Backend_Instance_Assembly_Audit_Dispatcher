/// <reference types="@cloudflare/workers-types" />

/**
 * Task message envelope for Cloudflare Queues.
 *
 * Each message carries a typed payload and metadata.
 * The consumer dispatches by `type` to the appropriate handler.
 */

export type TaskType =
  | 'image:pull'
  | 'workflow:job:run';

/** Container image pull — async heavyweight operation. */
export interface ImagePullPayload {
  taskId: string;
  image: string;
  instanceId?: string | undefined;
  clusterId?: string | undefined;
  credentialRef?: string | undefined;
  registryCredential?: {
    server: string;
    userName: string;
    password: string;
  } | undefined;
}

/** Workflow job execution — dispatched by WorkflowRunner to the Queue consumer. */
export interface WorkflowJobRunPayload {
  jobRunId: string;
  workflowRunId: string;
}

/** Discriminated union of all task message types. */
export interface TaskMessage {
  type: TaskType;
  payload: ImagePullPayload | WorkflowJobRunPayload;
  /** Unix ms — set by producer. */
  timestamp: number;
  /** Unique idempotency key — producer generates this. */
  id: string;
}

/** Result returned by a task handler. */
export interface TaskResult {
  success: boolean;
  error?: string;
}
