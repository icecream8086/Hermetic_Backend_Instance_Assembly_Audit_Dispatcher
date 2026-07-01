import { z } from 'zod';

// ── Shared ──

export const PodPhaseSchema = z.enum(['Pending', 'Running', 'Succeeded', 'Failed', 'Unknown']);

// ── Pod response shapes ──

export const PodCreateResponseSchema = z.object({
  podId: z.string(),
  providerId: z.string().optional(),
  phase: PodPhaseSchema,
  name: z.string(),
});

export const PodPhaseChangeResponseSchema = z.object({
  podId: z.string(),
  phase: PodPhaseSchema,
});

export const PodHealthSchema = z.object({
  containerName: z.string(),
  status: z.string(),
  ready: z.boolean(),
  startedAt: z.string().optional(),
  message: z.string().optional(),
});

export const PodExecResponseSchema = z.object({
  execId: z.string(),
  webSocketUri: z.string().optional(),
});

export const ContainerLogResultSchema = z.object({
  containerName: z.string(),
  content: z.string(),
  timestamp: z.string().optional(),
});

/** Minimal PodEntity — documented known fields. */
export const PodEntitySchema = z.object({
  podId: z.string(),
  name: z.string(),
  phase: PodPhaseSchema,
  providerId: z.string().optional(),
  creatorId: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const PodListResponseSchema = z.object({
  items: z.array(PodEntitySchema).readonly(),
  nextCursor: z.string().optional(),
});

// ── Sandbox response shapes ──

export const ContainerHealthSchema = z.object({
  containerName: z.string(),
  status: z.string(),
  ready: z.boolean(),
  startedAt: z.string().optional(),
  message: z.string().optional(),
});

/** Minimal Sandbox — documented known fields. */
export const SandboxSchema = z.object({
  id: z.string(),
  status: z.string(),
  podUid: z.string().optional(),
  providerId: z.string().optional(),
});

export const SandboxWithPodPhaseSchema = SandboxSchema.extend({
  podPhase: z.string().nullable(),
});

export const SandboxListResponseSchema = z.object({
  items: z.array(SandboxSchema).readonly(),
  nextCursor: z.string().optional(),
});

export const SandboxSyncResponseSchema = z.object({
  runtime: z.object({}),
  sandbox: SandboxSchema.nullable(),
});
