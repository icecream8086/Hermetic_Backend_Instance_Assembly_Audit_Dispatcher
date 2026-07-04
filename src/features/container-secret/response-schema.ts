import { z } from 'zod';

/**
 * ContainerSecret response schema matching the `redact(secret)` shape.
 * The `value` field is always `'[REDACTED]'` in API responses (replaced by
 * the redact() helper) or absent for upload-type secrets.
 */
export const ContainerSecretResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['inline', 'upload', 'platformRef']),
  description: z.string().optional(),
  value: z.literal('[REDACTED]').optional(),
  blobKey: z.string().optional(),
  filename: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
  status: z.enum(['active', 'inactive']),
  visibility: z.enum(['all', 'private', 'selected']),
  selectedScopeIds: z.array(z.string()).readonly(),
  keyType: z.enum(['aes-gcm', 'sealed-box']),
  sealedForUserId: z.string().optional(),
  platformRefs: z.object({
    eci: z.string().optional(),
    k8s: z.string().optional(),
    podman: z.string().optional(),
    aws: z.string().optional(),
  }).optional(),
  version: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** ContainerSecret list response: { items, total }. */
export const ContainerSecretListResponseSchema = z.object({
  items: z.array(ContainerSecretResponseSchema).readonly(),
  total: z.number(),
});

/** Public key response: { userId, publicKey, keyType }. */
export const PublicKeyResponseSchema = z.object({
  userId: z.string(),
  publicKey: z.string(),
  keyType: z.string(),
});

/** Check-access response: { allowed }. */
export const CheckAccessResponseSchema = z.object({
  allowed: z.boolean(),
});
