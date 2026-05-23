import { z } from 'zod';

export const PermissionRuleSchema = z.object({
  effect: z.enum(['allow', 'deny']),
  actions: z.array(z.string().min(1)).default([]),
  resource: z.string().max(200).optional(),
  priority: z.number().int().optional().default(0),
});

export const CreateSysGroupSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  description: z.string().max(500).optional(),
  rules: z.array(PermissionRuleSchema).default([]),
  priority: z.number().int().optional().default(0),
  dependsOn: z.array(z.string()).optional().default([]),
});

export const UpdateSysGroupSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional().nullable(),
  rules: z.array(PermissionRuleSchema).optional(),
  priority: z.number().int().optional(),
  dependsOn: z.array(z.string()).optional().nullable(),
});
