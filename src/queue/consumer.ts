/// <reference types="@cloudflare/workers-types" />

import { z } from 'zod';
import type { TaskMessage, TaskResult, ImagePullPayload, WorkflowJobRunPayload } from './types.ts';
import type { AppInstance } from '../core/deps.ts';
import { CredentialService } from '../core/auth/credential.ts';
import { WorkflowRunner } from '../features/actions/runner.ts';
import { formatDmesgLine } from '../core/utils/dmesg.ts';

/**
 * Queue consumer handlers — transport-agnostic task processing.
 *
 * The handlers work with plain TaskMessage arrays and AppInstance.
 * No Cloudflare types (MessageBatch, Queue) appear here.
 *
 * Two entry points:
 *   - processMessages(messages, instance)  — pure-function for in-process use
 *   - processTaskBatch(batch, getApp)       — Cloudflare MessageBatch adapter
 */

/**
 * Process a batch of task messages from a Cloudflare Queues batch.
 *
 * Thin adapter: maps MessageBatch → processMessages().
 * Each message is independently handled — one failure does not abort the batch.
 * Messages that fail are retried (via `msg.retry()`) up to the queue's
 * configured max_retries; messages that succeed are acked immediately.
 */
export async function processTaskBatch(
  batch: MessageBatch<TaskMessage>,
  getApp: () => Promise<AppInstance>,
): Promise<void> {
  try {
    const instance = await getApp();
    const messages = batch.messages;
    const results = await processMessages(messages.map(m => m.body), instance);

    for (let i = 0; i < messages.length; i++) {
      const r = results[i]!;
      const msg = messages[i]!;
      if (r.success) {
        msg.ack();
      } else {
        console.error(formatDmesgLine(`[queue] ${String(msg.body.type)} failed — ${String(r.error)}`));
        msg.retry({ delaySeconds: 5 });
      }
    }
  } catch (err) {
    console.error(formatDmesgLine(`[queue] batch processing panicked — ${err instanceof Error ? err.message : String(err)}`));
    // Don't rethrow — Wrangler doesn't handle async rejections well
  }
}

/**
 * Process an array of task messages using the same handlers.
 *
 * Transport-agnostic: works with any producer (CF Queue, EventLoop, test harness).
 * Each message is independently handled — one failure does not abort the batch.
 */
export async function processMessages(
  messages: TaskMessage[],
  instance: AppInstance,
): Promise<TaskResult[]> {
  const results: TaskResult[] = [];
  for (const msg of messages) {
    try {
      results.push(await handleTask(msg, instance));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(formatDmesgLine(`[queue] ${msg.type} panic — ${errorMsg}`));
      results.push({ success: false, error: errorMsg });
    }
  }
  return results;
}

/**
 * Task handler dispatch — validates payload against Zod schema before delegating.
 * CEA: no `any`, no `as`. Every task type validates its payload with `.parse()`.
 */
export async function handleTask(
  msg: TaskMessage,
  instance: AppInstance,
): Promise<TaskResult> {
  switch (msg.type) {
    case 'image:pull':         return handleImagePull(validateImagePullPayload(msg.payload), instance);
    case 'workflow:job:run':   return handleWorkflowJobRun(validateWorkflowJobRunPayload(msg.payload), instance);
    default: {
      const _exhaustive: never = msg.type;
      void _exhaustive;
      return { success: false, error: `Unknown task type: ${String(msg.type)}` };
    }
  }
}

// ── Payload validators (CEA: fail-fast on malformed queue messages) ──

const imagePullPayloadSchema = z.object({
  taskId: z.string(),
  image: z.string(),
  instanceId: z.string().optional(),
  clusterId: z.string().optional(),
  credentialRef: z.string().optional(),
  registryCredential: z.object({
    server: z.string(),
    userName: z.string(),
    password: z.string(),
  }).optional(),
});

const workflowJobRunPayloadSchema = z.object({
  jobRunId: z.string(),
  workflowRunId: z.string(),
});

function validateImagePullPayload(p: unknown): ImagePullPayload { return imagePullPayloadSchema.parse(p); }
function validateWorkflowJobRunPayload(p: unknown): WorkflowJobRunPayload { return workflowJobRunPayloadSchema.parse(p); }

// ─── Task handlers ───

async function handleImagePull(
  payload: ImagePullPayload,
  { stores, providers }: AppInstance,
): Promise<TaskResult> {
  const { taskId, image, instanceId, clusterId, credentialRef, registryCredential } = payload;

  const entry = await stores.atomic.get<any>('pull-task:' + taskId);
  if (!entry) return { success: true }; // task already cleaned up
  const taskBase = {
    id: taskId,
    repositoryId: entry.value.repositoryId,
    image,
    createdAt: entry.value.createdAt,
  };

  try {
    const imgProvider = instanceId
      ? await providers.resolveImage(instanceId as any)
      : providers.image;

    let credArg: string | { server: string; userName: string; password: string } | undefined = clusterId;
    if (credentialRef) {
      const secEnc = (stores as any).secretEncryption;
      const credSvc = new CredentialService(stores.atomic, secEnc);
      const managed = await credSvc.findByName(credentialRef);
      if (managed?.registryCredentials?.length) {
        credArg = {
          server: managed.registryCredentials[0]!.server,
          userName: managed.registryCredentials[0]!.userName,
          password: managed.registryCredentials[0]!.password,
        };
      }
    } else if (registryCredential) {
      credArg = registryCredential;
    }

    const info = await imgProvider.pull(image, credArg as any);
    await stores.atomic.set('pull-task:' + taskId, {
      ...taskBase,
      status: 'completed',
      result: { id: info.id, tags: [...info.tags] },
      completedAt: Date.now(),
    }, entry.version);
    return { success: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[queue] image.pull ${taskId} failed:`, msg);
    await stores.atomic.set('pull-task:' + taskId, {
      ...taskBase,
      status: 'failed',
      error: msg,
      failedAt: Date.now(),
    }, entry.version);
    const errResult = { success: false, error: msg };
    return errResult;
  }
}

async function handleWorkflowJobRun(
  payload: WorkflowJobRunPayload,
  { stores, providers, audit, eventBus }: AppInstance,
): Promise<TaskResult> {
  try {
    const runner = new WorkflowRunner({
      stores,
      providers: {
        dns: providers.dns,
        resolveContainer: providers.resolveContainer.bind(providers),
      },
      audit,
      eventBus,
    });

    await runner.executeJob(payload.jobRunId as any);
    return { success: true };
  } catch (err) {
    const errResult = { success: false, error: err instanceof Error ? err.message : String(err) };
    return errResult;
  }
}
