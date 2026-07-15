import { z } from 'zod';
import { VolumeStatus } from '../../core/volume/types.ts';

/** Volume response schema — matches the Volume entity shape for API docs. */
export const VolumeSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  tags: z.array(z.object({ key: z.string(), value: z.string() })).readonly().default([]),
  createdAt: z.number(),
  updatedAt: z.number(),
  status: z.enum([VolumeStatus.Detached, VolumeStatus.Attached, VolumeStatus.Orphaned]),
  type: z.string(),
  instanceId: z.string(),
  credentialRef: z.string().optional(),
  nfs: z.object({
    server: z.string(),
    path: z.string(),
    readOnly: z.boolean().optional(),
  }).optional(),
  disk: z.object({
    diskId: z.string(),
    fsType: z.string().optional(),
    sizeGiB: z.number().optional(),
    readOnly: z.boolean().optional(),
    deleteWithInstance: z.boolean().optional(),
  }).optional(),
  secret: z.object({
    name: z.string(),
    items: z.array(z.object({
      key: z.string(),
      path: z.string(),
      mode: z.number().optional(),
    })).readonly().optional(),
  }).optional(),
  configMap: z.object({
    name: z.string(),
    items: z.array(z.object({
      key: z.string(),
      path: z.string(),
      mode: z.number().optional(),
    })).readonly().optional(),
  }).optional(),
  oss: z.object({
    bucket: z.string(),
    path: z.string().optional(),
    readOnly: z.boolean().optional(),
    endpoint: z.string().optional(),
  }).optional(),
}).openapi('Volume');

/** Paginated volume list wrapper. */
export const VolumeListResponseSchema = z.object({
  items: z.array(VolumeSchema).readonly(),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
});
