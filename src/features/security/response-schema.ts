import { z } from 'zod';
import { SecurityResourceStatus } from '../../core/security/types.ts';

export const StorageAccessEntrySchema = z.object({
  prefix: z.string(),
  permissions: z.array(z.enum(['read', 'write', 'list'])),
});

export const SecurityResourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  bucketId: z.string(),
  instanceId: z.string(),
  tokenTtl: z.number(),
  presignedUrlTtl: z.number(),
  accessPolicy: z.array(StorageAccessEntrySchema),
  status: z.enum([SecurityResourceStatus.Active, SecurityResourceStatus.Expired, SecurityResourceStatus.Revoked]),
  createdAt: z.number(),
  updatedAt: z.number(),
}).openapi('SecurityResource');

export const SecurityResourceListResponseSchema = z.object({
  items: z.array(SecurityResourceSchema).readonly(),
});

// ─── Container-facing response schemas ───

export const PresignResponseSchema = z.object({
  url: z.string(),
  bucket: z.string(),
  key: z.string(),
  expiresAt: z.string(),
});

export const BatchPresignResponseSchema = z.object({
  urls: z.array(z.object({
    bucket: z.string(),
    key: z.string(),
    url: z.string(),
    expiresAt: z.string(),
  })),
});

export const ListResponseSchema = z.object({
  files: z.array(z.object({
    key: z.string(),
    size: z.number(),
    lastModified: z.string().optional(),
  })),
  nextContinuationToken: z.string().optional(),
  isTruncated: z.boolean(),
});
