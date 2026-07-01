import { z } from 'zod';

export const RunnerInstanceSchema = z.object({
  id: z.string(),
  name: z.string(),
  os: z.enum(['linux', 'win', 'mac']),
  status: z.enum(['online', 'offline']),
  busy: z.boolean(),
  labels: z.array(z.string()).readonly(),
  providerInstanceId: z.string().optional(),
  groupIds: z.array(z.string()).readonly(),
  registeredAt: z.number(),
  lastHeartbeatAt: z.number(),
});

export const RegistrationTokenSchema = z.object({
  token: z.string(),
  expiresAt: z.number(),
  createdAt: z.number(),
});

export const RunnerGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  visibility: z.enum(['all', 'selected']),
  selectedScopeIds: z.array(z.string()).readonly(),
  dependsOn: z.array(z.string()).readonly(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const RegisterResultSchema = z.object({
  runner: RunnerInstanceSchema,
  token: RegistrationTokenSchema,
});

export const RunnerListResultSchema = z.object({
  items: z.array(RunnerInstanceSchema).readonly(),
  total: z.number(),
});

export const GroupListResultSchema = z.object({
  items: z.array(RunnerGroupSchema).readonly(),
  total: z.number(),
});

export const MarkStaleResultSchema = z.object({
  markedOffline: z.number(),
});

export const ValidateTokenResultSchema = z.object({
  valid: z.boolean(),
});
