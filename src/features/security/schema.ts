import { z } from 'zod';

// ─── CRUD ───

export const CreateSecurityResourceSchema = z.object({
  name: z.string().min(1).max(200),
  bucketId: z.string().min(1),
  instanceId: z.string().min(1),
  tokenTtl: z.number().int().positive().optional(),
  presignedUrlTtl: z.number().int().positive().optional(),
  accessPolicy: z.array(z.object({
    prefix: z.string(),
    permissions: z.array(z.enum(['read', 'write', 'list'])),
  })).optional(),
});

export const UpdateSecurityResourceSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  tokenTtl: z.number().int().positive().optional(),
  presignedUrlTtl: z.number().int().positive().optional(),
  accessPolicy: z.array(z.object({
    prefix: z.string(),
    permissions: z.array(z.enum(['read', 'write', 'list'])),
  })).optional(),
});

// ─── Container-facing ───

export const PresignQuerySchema = z.object({
  bucket: z.string().min(1),
  key: z.string().min(1),
  method: z.enum(['GET', 'PUT']),
});

export const BatchPresignSchema = z.object({
  files: z.array(z.object({
    bucket: z.string().min(1),
    key: z.string().min(1),
    method: z.enum(['GET', 'PUT']),
  })).min(1).max(100),
});

export const ListQuerySchema = z.object({
  bucket: z.string().min(1),
  prefix: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  continuationToken: z.string().optional(),
});
