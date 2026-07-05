import { z } from 'zod';
import { VolumeType } from '../../core/volume/types.ts';

const NFSOptionsSchema = z.object({
  server: z.string().min(1, 'NFS server is required'),
  path: z.string().min(1, 'NFS path is required'),
  readOnly: z.boolean().default(false),
});

const DiskOptionsSchema = z.object({
  diskId: z.string().min(1, 'Disk ID is required'),
  fsType: z.string().default('ext4'),
  sizeGiB: z.number().int().positive().optional(),
  diskCategory: z.enum(['cloud_efficiency', 'cloud_ssd', 'cloud_essd']).optional(),
  readOnly: z.boolean().default(false),
  deleteWithInstance: z.boolean().optional(),
});

const SecretOptionsSchema = z.object({
  name: z.string().min(1, 'Secret name is required'),
  items: z.array(z.object({
    key: z.string().min(1),
    path: z.string().min(1),
    mode: z.number().int().optional(),
  })).optional(),
});

export const CreateVolumeSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  description: z.string().max(500).optional(),
  instanceId: z.string().min(1, 'instanceId is required — volumes must be bound to a compute instance'),
  credentialRef: z.string().optional(),
  type: z.enum(VolumeType),
  nfs: NFSOptionsSchema.optional(),
  disk: DiskOptionsSchema.optional(),
  secret: SecretOptionsSchema.optional(),
});

export const UpdateVolumeSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional().nullable(),
  instanceId: z.string().optional().nullable(),
  credentialRef: z.string().optional().nullable(),
  nfs: NFSOptionsSchema.optional().nullable(),
  disk: DiskOptionsSchema.optional().nullable(),
  secret: SecretOptionsSchema.optional().nullable(),
});
