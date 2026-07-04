import { z } from 'zod';

export const FileInfoSchema = z.object({
  key: z.string(),
  size: z.number(),
  sha256: z.string().nullable(),
  lastModified: z.string().optional(),
});

export const ListFilesResponseSchema = z.object({
  files: z.array(FileInfoSchema),
  nextContinuationToken: z.string().optional(),
  isTruncated: z.boolean(),
});

export const DiffResponseSchema = z.object({
  toUpload: z.array(z.object({ key: z.string(), sha256: z.string(), size: z.number() })),
  unchanged: z.array(z.object({ key: z.string() })),
  orphaned: z.array(z.object({ key: z.string() })),
});

export const PresignForSyncResponseSchema = z.object({
  url: z.string(),
  bucket: z.string(),
  key: z.string(),
  expiresAt: z.string(),
  headers: z.object({
    'x-amz-meta-sha256': z.string(),
    'Content-Type': z.string(),
    'Content-Length': z.string(),
  }),
});
