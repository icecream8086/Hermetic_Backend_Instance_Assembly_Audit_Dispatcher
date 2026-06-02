import { z } from 'zod';

const CidrPattern = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

const CidrSchema = z.string().regex(CidrPattern, 'Invalid CIDR format, expected e.g. "10.2.0.0/16"');

export const CreateNetworkSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  cidr: CidrSchema,
  subnetPrefix: z.number().int().min(1).max(31),
  securityGroupId: z.string().optional(),
  provider: z.string().min(1),
  region: z.string().min(1),
  visibility: z.enum(['public', 'private']).optional().default('private'),
  userIds: z.array(z.string()).optional(),
  userGroupIds: z.array(z.string()).optional(),
});

export const UpdateNetworkSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  securityGroupId: z.string().nullable().optional(),
  visibility: z.enum(['public', 'private']).optional(),
  userIds: z.array(z.string()).nullable().optional(),
  userGroupIds: z.array(z.string()).nullable().optional(),
  status: z.enum(['Active', 'Inactive', 'Error']).optional(),
});

export const NetworkQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  visibility: z.enum(['public', 'private']).optional(),
  provider: z.string().optional(),
  region: z.string().optional(),
});
