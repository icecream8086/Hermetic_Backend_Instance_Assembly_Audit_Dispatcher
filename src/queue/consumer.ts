/// <reference types="@cloudflare/workers-types" />

import { z } from 'zod';
import type { TaskMessage, TaskResult, SandboxGcPayload, ImagePullPayload, SandboxProvisionPayload, BucketKeyRotatePayload, WorkflowJobRunPayload } from './types.ts';
import type { AppInstance } from '../core/deps.ts';
import { SandboxStatus } from '../features/sandbox/types.ts';
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
    case 'sandbox:gc':         return handleSandboxGc(validateSandboxGcPayload(msg.payload), instance);
    case 'sandbox:provision':  return handleSandboxProvision(validateSandboxProvisionPayload(msg.payload), instance);
    case 'bucket-key:rotate':  return handleBucketKeyRotate(validateBucketKeyRotatePayload(msg.payload), instance);
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

const sandboxGcPayloadSchema = z.object({
  sandboxId: z.string(),
  reason: z.enum(['stopped-gc', 'provider-gone', 'exited-gc', 'unhealthy-gc', 'manual', 'failed-gc', 'expired-gc', 'stuck-gc']),
  providerId: z.string(),
  region: z.string(),
  instanceId: z.string().optional(),
  containerCount: z.number(),
  sandboxName: z.string(),
  createdAt: z.number(),
});

const sandboxProvisionPayloadSchema = z.object({
  sandboxId: z.string(),
  providerId: z.string(),
  instanceId: z.string().optional(),
});

const bucketKeyRotatePayloadSchema = z.object({
  bindingId: z.string(),
});

const workflowJobRunPayloadSchema = z.object({
  jobRunId: z.string(),
  workflowRunId: z.string(),
});

function validateImagePullPayload(p: unknown): ImagePullPayload { return imagePullPayloadSchema.parse(p); }
function validateSandboxGcPayload(p: unknown): SandboxGcPayload { return sandboxGcPayloadSchema.parse(p); }
function validateSandboxProvisionPayload(p: unknown): SandboxProvisionPayload { return sandboxProvisionPayloadSchema.parse(p); }
function validateBucketKeyRotatePayload(p: unknown): BucketKeyRotatePayload { return bucketKeyRotatePayloadSchema.parse(p); }
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
    console.error(`[queue] image.pull ${taskId} failed:`, e instanceof Error ? e.message : String(e));
    await stores.atomic.set('pull-task:' + taskId, {
      ...taskBase,
      status: 'failed',
      error: e.message,
      failedAt: Date.now(),
    }, entry.version);
    return { success: false, error: e.message };
  }
}

async function handleSandboxGc(
  payload: SandboxGcPayload,
  instance: AppInstance,
): Promise<TaskResult> {
  const { stores, providers, audit } = instance;
  const { sandboxId, reason, providerId, region, instanceId, containerCount, sandboxName, createdAt } = payload;
  const sid = sandboxId;

  try {
    // Delete provider resource first (best-effort) — resolve per-instance provider.
    // Never fall back to default for a specific instance: sending an ECI delete to
    // Podman (or vice-versa) would silently orphan the cloud resource.
    try {
      // Must have instanceId to resolve the right provider — no global default.
      if (!instanceId || !providers.resolveContainer) return { success: true };
      const provider = await providers.resolveContainer(instanceId as any);
      await Promise.race([
        provider.delete({ region: region as any, providerId }),
        new Promise((_, reject) => setTimeout(() => { reject(new Error('GC delete timeout after 10s')); }, 10_000)),
      ]);
    } catch { /* best-effort — provider may be unreachable or the resource already gone */ }

    // Update sandbox state to Deleted with OCC retry
    let deleted = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const latest = await stores.atomic.get<any>('sandbox:' + sid);
      if (!latest || latest.value.status === SandboxStatus.Deleted) {
        deleted = true;
        break;
      }
      const ver = await stores.atomic.set('sandbox:' + sid, {
        ...latest.value,
        status: SandboxStatus.Deleted,
        updatedAt: Date.now(),
      }, latest.version);
      if (!ver) continue;

      // Remove from index
      const idxEntry = await stores.atomic.get<string[]>('sandbox:ids');
      if (idxEntry) {
        await stores.atomic.set('sandbox:ids',
          idxEntry.value.filter((i: string) => i !== sid),
          idxEntry.version,
        );
      }

      console.log(formatDmesgLine(
        `sandbox DELETED (${reason}) id=${sid} name=${sandboxName} ` +
        `provider=${providerId} containers=${String(containerCount)} ` +
        `uptime=${String(Date.now() - createdAt)}ms [via-queue]`,
      ));

      audit?.write({
        level: 4,
        facility: 'sandbox-service',
        message: `Sandbox auto-deleted (${reason}) — ${sid} [via-queue]`,
        metadata: {
          eventType: 'sandbox.auto-deleted',
          sandboxId: sid,
          reason,
        },
      });
      deleted = true;
      break;
    }

    if (!deleted) {
      return { success: false, error: 'OCC retries exhausted' };
    }

    // Clear GC marker so the tick doesn't re-enqueue
    const markerKey = 'gc:queued:' + sid;
    const marker = await stores.atomic.get<{ version: number }>(markerKey);
    if (marker) await stores.atomic.set(markerKey, null, marker.version).catch(() => { /* noop */ });

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleSandboxProvision(
  payload: SandboxProvisionPayload,
  { stores }: AppInstance,
): Promise<TaskResult> {
  // Post-provision async steps: bucket key bindings, DNS, etc.
  // These don't block the create response — they run after provision returns.
  try {
    const entry = await stores.atomic.get<any>('sandbox:' + payload.sandboxId);
    if (!entry) return { success: true };

    // Future: auto-generate bucket keys, register DNS records, send notifications
    // Currently these are done synchronously in sandbox.service.ts provision().
    // This handler exists as a migration target — once provision is refactored
    // to push async steps here, the sync path can shed latency.

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleBucketKeyRotate(
  payload: BucketKeyRotatePayload,
  { stores }: AppInstance,
): Promise<TaskResult> {
  const BINDING_PREFIX = 'bucket-key:';
  const { bindingId } = payload;

  try {
    // Re-read binding in case it was rotated between enqueue and consume
    const entry = await stores.atomic.get<any>(BINDING_PREFIX + bindingId);
    if (!entry?.value) return { success: true }; // already cleaned up
    if (entry.value.expiresAt > Date.now()) return { success: true }; // not yet expired

    const binding = entry.value;
    const ak = binding.accessKeyId;
    const sk = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b: number) => b.toString(16).padStart(2, '0'))
      .join('');
    binding.secretValue = `${String(ak)}:${sk}`;
    binding.version++;
    binding.expiresAt = Date.now() + Number(binding.rotationIntervalMs ?? 24 * 60 * 60 * 1000);

    const ver = await stores.atomic.set(BINDING_PREFIX + bindingId, binding, entry.version);
    if (!ver) return { success: false, error: 'OCC conflict on key rotation' };

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
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
        resolveContainer: providers.resolveContainer?.bind(providers),
      },
      audit,
      eventBus,
    });

    await runner.executeJob(payload.jobRunId as any);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
