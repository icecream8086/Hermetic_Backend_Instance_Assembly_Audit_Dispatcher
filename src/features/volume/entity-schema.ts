/**
 * Zod schema for Volume entity — the single source of truth.
 *
 * TypeScript types are DERIVED from this schema via z.infer, not
 * declared separately. This eliminates schema↔type drift.
 *
 * Pattern: Schema → z.infer → type  (not the reverse)
 */

import { z } from 'zod';
import { VolumeType, VolumeStatus, createVolumeId } from '../sandbox/types.ts';

// ─── Sub-schemas ───

const NFSVolumeConfigSchema = z.object({
  server: z.string(),
  path: z.string(),
  readOnly: z.boolean(),
});

const DiskVolumeConfigSchema = z.object({
  diskId: z.string(),
  fsType: z.string(),
  sizeGiB: z.number().int().positive().optional(),
  diskCategory: z.enum(['cloud_efficiency', 'cloud_ssd', 'cloud_essd']).optional(),
  readOnly: z.boolean(),
  deleteWithInstance: z.boolean().optional(),
});

const SecretVolumeConfigSchema = z.object({
  name: z.string(),
  items: z.array(z.object({
    key: z.string(),
    path: z.string(),
    mode: z.number().int().optional(),
  })).optional(),
});

// ─── Entity schema — the authoritative type source ───

export const VolumeSchema = z.object({
  id: z.string().transform((s) => createVolumeId(s)),
  name: z.string(),
  tags: z.array(z.object({ key: z.string(), value: z.string() })).default([]),
  createdAt: z.number(),
  updatedAt: z.number(),
  status: z.nativeEnum(VolumeStatus),
  type: z.nativeEnum(VolumeType),
  instanceId: z.string(),
  credentialRef: z.string().optional(),
  nfs: NFSVolumeConfigSchema.optional(),
  disk: DiskVolumeConfigSchema.optional(),
  secret: SecretVolumeConfigSchema.optional(),
});

/** Entity type derived from the schema — the single source of truth. */
export type Volume = z.infer<typeof VolumeSchema>;

// ─── I/O schemas (used by handlers) ───

export const CreateVolumeSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  description: z.string().max(500).optional(),
  instanceId: z.string().min(1, 'instanceId is required — volumes must be bound to a compute instance'),
  credentialRef: z.string().optional(),
  type: z.nativeEnum(VolumeType),
  nfs: NFSVolumeConfigSchema.optional(),
  disk: DiskVolumeConfigSchema.optional(),
  secret: SecretVolumeConfigSchema.optional(),
});

export const UpdateVolumeSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional().nullable(),
  instanceId: z.string().optional().nullable(),
  credentialRef: z.string().optional().nullable(),
  nfs: NFSVolumeConfigSchema.optional().nullable(),
  disk: DiskVolumeConfigSchema.optional().nullable(),
  secret: SecretVolumeConfigSchema.optional().nullable(),
});

export type CreateVolumeInput = z.infer<typeof CreateVolumeSchema>;
export type UpdateVolumeInput = z.infer<typeof UpdateVolumeSchema>;
