import type { Context } from 'hono';
import type { AppContext } from '../deps.ts';
import { AppError } from '../types.ts';
import { base64urlDecode, verifyToken } from './jwt.ts';
import type { S3AccessTokenClaims } from './types.ts';

declare module '../deps.ts' {
  interface AppContext {
    jwtClaims?: S3AccessTokenClaims;
  }
}

export async function jwtAuthMiddleware(c: Context<{ Variables: AppContext }>, next: () => Promise<void>): Promise<void> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AppError(401, 'UNAUTHORIZED', 'Missing or malformed Authorization header');
  }
  const atomic = c.var.stores.atomic;
  const secretEntry = await atomic.get<string>('_sys:jwt-secret');
  if (!secretEntry?.value) throw new AppError(500, 'INTERNAL_ERROR', 'JWT secret not configured');
  const secret = base64urlDecode(secretEntry.value);
  const result = await verifyToken(authHeader.slice(7), secret);
  if (!result.valid) throw new AppError(401, 'UNAUTHORIZED', result.reason);
  c.set('jwtClaims', result.claims);
  await next();
}
