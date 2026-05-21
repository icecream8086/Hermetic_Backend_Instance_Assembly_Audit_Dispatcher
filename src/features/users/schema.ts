import { z } from 'zod';
import { UserRole } from './types.ts';

// ─── Request schemas ───

export const RegisterUserSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  name: z.string().min(1, 'Name is required').max(100),
  role: z.nativeEnum(UserRole).optional().default(UserRole.Viewer),
});

export const LoginUserSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(1, 'Password is required'),
});

export const LoginTimeRangeSchema = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:mm format'),
  end: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:mm format'),
});

export const LoginPolicySchema = z.object({
  enabled: z.boolean(),
  timeRanges: z.array(LoginTimeRangeSchema).default([]),
  allowedCIDRs: z.array(z.string()).default([]),
});

export const PublicKeySchema = z.string().regex(/^[A-Za-z0-9+/]{43}=?$/, 'Invalid Ed25519 public key (base64, 32 bytes)');

export const NoPasswordLoginSchema = z.object({
  email: z.string().email('Invalid email format'),
  oneTimeKey: z.string().min(1, 'One-time key is required'),
});

export const UpdateUserSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  password: z.string().min(8).max(128).optional(),
  role: z.nativeEnum(UserRole).optional(),
  loginPolicy: LoginPolicySchema.optional(),
  publicKeyEd25519: PublicKeySchema.optional(),
  privateKeyEd25519: z.string().optional(),
});

// ─── Response schemas ───

export const UserResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.nativeEnum(UserRole),
  createdAt: z.number(),
  updatedAt: z.number(),
  privateKeyEd25519: z.string().default(''),
});

export const LoginResponseSchema = z.object({
  token: z.string(),
  user: UserResponseSchema,
});

// ─── Inferred types ───

export type RegisterUserInput = z.infer<typeof RegisterUserSchema>;
export type LoginUserInput = z.infer<typeof LoginUserSchema>;
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;
export type UserResponse = z.infer<typeof UserResponseSchema>;
export type LoginResponse = z.infer<typeof LoginResponseSchema>;
export type NoPasswordLoginInputT = z.infer<typeof NoPasswordLoginSchema>;
