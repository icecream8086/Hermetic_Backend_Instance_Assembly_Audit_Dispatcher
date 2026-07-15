import { z } from 'zod';
import { PermissionRuleSchema } from './schema.ts';

export const SysGroupSchema = z.object({
  id: z.string(),
  gid: z.number(),
  name: z.string(),
  description: z.string().optional(),
  rules: z.array(PermissionRuleSchema).readonly(),
  priority: z.number(),
  dependsOn: z.array(z.string()).readonly(),
  createdAt: z.number(),
  updatedAt: z.number(),
}).openapi('SysGroup');
