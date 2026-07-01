import { z } from 'zod';

/**
 * Minimal response schema for SandboxTemplate.
 * Matches the domain interface shape for OpenAPI documentation.
 */
export const SandboxTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  apiVersion: z.string(),
  kind: z.enum(['Container', 'ContainerGroup']),
  metadata: z.object({
    author: z.string().optional(),
    labels: z.record(z.string(), z.string()).optional(),
    annotations: z.record(z.string(), z.string()).optional(),
  }).optional(),
  dependsOn: z.array(z.string()).readonly().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  creatorId: z.string().optional(),
  visibility: z.enum(['public', 'private']).optional(),
  singleton: z.boolean().optional(),
  instanceLimit: z.object({
    type: z.enum(['fixed', 'perUser', 'perSystem']),
    max: z.number(),
  }).optional(),
  resourceBinding: z.object({
    domain: z.string().optional(),
    port: z.number().optional(),
  }).optional(),
  container: z.object({
    region: z.string(),
    zone: z.string().optional(),
    instanceId: z.string().optional(),
    account: z.string().optional(),
    restartPolicy: z.string().optional(),
    containers: z.array(z.object({})).readonly(),
    initContainers: z.array(z.object({})).readonly().optional(),
  }).optional(),
  healthChecks: z.array(z.object({})).readonly().optional(),
  network: z.object({}).optional(),
  extensions: z.object({}).optional(),
  podSpec: z.object({}).optional(),
});

/** Template with resolved DAG chain. */
export const ResolvedTemplateSchema = SandboxTemplateSchema.extend({
  _chain: z.array(z.string()).readonly(),
});

/** Template delete / mask response. */
export const TemplateDeleteResponseSchema = z.object({
  masked: z.boolean(),
  id: z.string(),
});
