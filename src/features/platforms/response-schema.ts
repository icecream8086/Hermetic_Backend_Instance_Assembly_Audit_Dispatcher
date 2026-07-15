import { z } from 'zod';

/** Platform list item. */
export const PlatformItemSchema = z.object({
  name: z.string(),
  containerAvailable: z.boolean(),
});

/** Extension field definition — matches ExtensionFieldDef interface. */
const ExtensionFieldDefSchema = z.object({
  key: z.string(),
  type: z.string(),
  label: z.string(),
  description: z.string(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  eciParam: z.string().optional(),
  transform: z.enum(['boolean-string', 'number-string', 'json-string', 'comma-sep']).optional(),
  validation: z.object({
    enum: z.array(z.string()).readonly().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    pattern: z.string().optional(),
  }).optional(),
  scope: z.enum(['pod', 'container', 'volume', 'network']),
  category: z.string().optional(),
});

/** Extension fields response. */
export const ExtensionFieldsSchema = z.object({
  provider: z.string(),
  label: z.string(),
  instanceId: z.string(),
  instanceName: z.string(),
  fields: z.array(ExtensionFieldDefSchema).readonly(),
});

/** Platform region list response. */
export const PlatformRegionsResponseSchema = z.object({
  platform: z.string(),
  regions: z.array(z.record(z.string(), z.unknown())).readonly(),
});
