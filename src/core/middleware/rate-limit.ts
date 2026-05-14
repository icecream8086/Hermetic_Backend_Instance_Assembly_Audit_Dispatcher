import type { MiddlewareHandler } from 'hono';
import { AppError } from '../types.ts';

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

/**
 * Simple in-memory sliding-window rate limiter.
 * For production, replace with distributed store (KV / Redis / DO).
 */
export function rateLimit(config: RateLimitConfig): MiddlewareHandler {
  const hits = new Map<string, number[]>();

  // Periodic cleanup of expired entries
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of hits) {
      const valid = timestamps.filter((t) => now - t < config.windowMs);
      if (valid.length === 0) hits.delete(key);
      else hits.set(key, valid);
    }
  }, config.windowMs * 2);

  if (typeof cleanup === 'object' && 'unref' in cleanup) cleanup.unref();

  return async (c, next) => {
    const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';
    const now = Date.now();
    const timestamps = hits.get(ip) ?? [];

    const valid = timestamps.filter((t) => now - t < config.windowMs);
    if (valid.length >= config.maxRequests) {
      throw new AppError(429, 'RATE_LIMITED', `Too many requests. Max ${config.maxRequests} per ${config.windowMs}ms`);
    }

    valid.push(now);
    hits.set(ip, valid);
    await next();
  };
}
