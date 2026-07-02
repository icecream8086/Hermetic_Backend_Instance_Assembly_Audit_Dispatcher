import { z } from 'zod';
import { SecurityResourceStatus } from '../../core/security/types.ts';

/** Presigned URL set — only expiresAt exposed for list/get, actual URLs are sensitive. */
export const PresignedUrlInfoSchema = z.object({
  expiresAt: z.string(),
});

/** Full SecurityResource response schema. value 脱敏，仅显示 expiresAt。 */
export const SecurityResourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  bucketId: z.string(),
  instanceId: z.string(),
  validDuration: z.number(),
  refreshThreshold: z.number(),
  status: z.enum(SecurityResourceStatus),
  value: PresignedUrlInfoSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const SecurityResourceListResponseSchema = z.object({
  items: z.array(SecurityResourceSchema).readonly(),
});
