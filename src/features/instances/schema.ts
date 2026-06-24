import { z } from 'zod';

export const CreateRunnerSchema = z.object({
  name: z.string().min(1, 'name is required').max(200),
  os: z.enum(['linux', 'win', 'mac']).optional().default('linux'),
  labels: z.array(z.string().max(100)).optional().default([]),
  providerInstanceId: z.string().optional(),
  groupIds: z.array(z.string()).optional().default([]),
});

export const UpdateRunnerSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  labels: z.array(z.string().max(100)).optional(),
  groupIds: z.array(z.string()).optional(),
});

export const CreateRunnerGroupSchema = z.object({
  name: z.string().min(1, 'name is required').max(200),
  visibility: z.enum(['all', 'selected']).optional().default('all'),
  selectedScopeIds: z.array(z.string()).optional().default([]),
  dependsOn: z.array(z.string()).optional().default([]),
});

export const ValidateTokenSchema = z.object({
  token: z.string().min(1, 'token is required'),
});
