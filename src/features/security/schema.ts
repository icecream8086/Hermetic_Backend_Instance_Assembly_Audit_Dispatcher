import { z } from 'zod';

export const CreateSecurityResourceSchema = z.object({
  name: z.string().min(1).max(200),
  bucketId: z.string().min(1),
  instanceId: z.string().min(1),
  validDuration: z.number().int().positive().optional(),
  refreshThreshold: z.number().int().positive().optional(),
});

export const UpdateSecurityResourceSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  validDuration: z.number().int().positive().optional(),
  refreshThreshold: z.number().int().positive().optional(),
});
