import { z } from 'zod';

/**
 * Minimal response schema for Template.
 * Matches the domain interface shape for OpenAPI documentation.
 */
export const TemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  apiVersion: z.string(),
  kind: z.enum(['Pod']),
  metadata: z.object({
    labels: z.record(z.string(), z.string()).optional(),
    annotations: z.record(z.string(), z.string()).optional(),
  }).optional(),
  spec: z.object({}),
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
}).openapi({ ref: 'PodTemplate' });

/** Template with resolved DAG chain. */
export const ResolvedTemplateSchema = TemplateSchema.extend({
  _chain: z.array(z.string()).readonly(),
});

/** Template delete / mask response. */
export const TemplateDeleteResponseSchema = z.object({
  masked: z.boolean(),
  id: z.string(),
});
