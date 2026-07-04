import { z } from 'zod';

export const ListFilesQuerySchema = z.object({
  prefix: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  continuationToken: z.string().optional(),
});

export const DiffRequestSchema = z.object({
  files: z.array(z.object({
    key: z.string().min(1),
    sha256: z.string(),
    size: z.number().int().nonnegative(),
  })).min(1).max(10000),
});

export const PresignForSyncRequestSchema = z.object({
  file: z.object({
    key: z.string().min(1),
    sha256: z.string(),
    size: z.number().int().nonnegative(),
  }),
  ttl: z.number().int().positive().max(3600).optional(),
});
