import { z } from 'zod';
import { PodSpecSchema, PodNetworkSchema, ContainerRuntimeSchema, PodConditionSchema, PodEventSchema } from '../../core/pod/schema.ts';
import { versionIdSchema } from '../../core/brand.ts';

// ── Shared ──

export const PodPhaseSchema = z.enum(['Pending', 'Running', 'Succeeded', 'Failed', 'Unknown']).openapi('PodPhase');

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
}).openapi('PodPhaseChange');

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

export const PodEntitySchema = z.object({
  podId: z.string(),
  name: z.string(),
  phase: PodPhaseSchema,
  providerId: z.string().optional(),
  creatorId: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  spec: PodSpecSchema,
  deletionTimestamp: z.string().optional(),
  network: PodNetworkSchema,
  containers: z.array(ContainerRuntimeSchema).readonly(),
  conditions: z.array(PodConditionSchema).readonly(),
  events: z.array(PodEventSchema).readonly(),
  version: versionIdSchema,
  templateRef: z.string().optional(),
}).openapi('PodEntity');

export const PodListResponseSchema = z.object({
  items: z.array(PodEntitySchema).readonly(),
  nextCursor: z.string().optional(),
});
