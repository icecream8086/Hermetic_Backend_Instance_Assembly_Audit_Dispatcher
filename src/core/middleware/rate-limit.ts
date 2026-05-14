import type { MiddlewareHandler } from 'hono';
import { AppError } from '../types.ts';

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

/**
 * Simple in-memory sliding-window rate limiter.
 * Expired entries are purged lazily on each request — no background timer.
 * For production, replace with distributed store (KV / Redis / DO).
 */
export function rateLimit(config: RateLimitConfig): MiddlewareHandler {
  const hits = new Map<string, number[]>();

  return async (c, next) => {
    const now = Date.now();
    const cutoff = now - config.windowMs;

    // Lazy cleanup: purge fully-expired IPs from the map
    for (const [key, timestamps] of hits) {
      const valid = timestamps.filter((t) => t > cutoff);
      if (valid.length === 0) hits.delete(key);
      else if (valid.length < timestamps.length) hits.set(key, valid);
    }

    const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';
    const timestamps = hits.get(ip) ?? [];

    const valid = timestamps.filter((t) => t > cutoff);
    if (valid.length >= config.maxRequests) {
      throw new AppError(429, 'RATE_LIMITED', `Too many requests. Max ${config.maxRequests} per ${config.windowMs}ms`);
    }

    valid.push(now);
    hits.set(ip, valid);
    await next();
  };
}
