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

export const UpdateUserSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  password: z.string().min(8).max(128).optional(),
  role: z.nativeEnum(UserRole).optional(),
});

// ─── Response schemas ───

export const UserResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.nativeEnum(UserRole),
  createdAt: z.number(),
  updatedAt: z.number(),
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
