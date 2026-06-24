import { z } from 'zod';

export const CreateContainerSecretSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  description: z.string().max(500).optional(),
  type: z.enum(['inline', 'upload']),
  value: z.string().optional(),
  status: z.enum(['active', 'inactive']).optional(),
  visibility: z.enum(['all', 'private', 'selected']).optional().default('all'),
  selectedScopeIds: z.array(z.string()).optional().default([]),
  keyType: z.enum(['aes-gcm', 'sealed-box']).optional().default('aes-gcm'),
  sealForUserId: z.string().optional(),
}).refine(data => {
  if (data.type === 'inline' && !data.value) return false;
  return true;
}, { message: 'value is required for inline type', path: ['value'] });

export const UpdateContainerSecretSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional().nullable(),
  value: z.string().optional().nullable(),
  status: z.enum(['active', 'inactive']).optional(),
  visibility: z.enum(['all', 'private', 'selected']).optional(),
  selectedScopeIds: z.array(z.string()).optional().nullable(),
});
