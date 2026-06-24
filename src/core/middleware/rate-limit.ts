/**
 * Token bucket rate limiter (inspired by Linux printk_ratelimit).
 *
 * burst + interval model: allows `burst` requests initially, then
 * replenishes at rate of 1 token per `intervalMs / burst`.
 * This replaces the old windowMs+maxRequests sliding window with
 * a more predictable token bucket algorithm.
 */
import type { MiddlewareHandler } from 'hono';
import { AppError } from '../types.ts';

export interface RateLimitConfig {
  /** Maximum tokens in the bucket (initial burst capacity). Default 10. */
  burst: number;
  /** Interval in ms over which tokens replenish. Default 5000 (5s). */
  intervalMs: number;
  /** Master kill switch. Default: true. */
  enabled?: boolean;
  /** IPs or CIDRs exempt from rate limiting. */
  bypassIps?: readonly string[];
  /** Shared secret for header-based bypass. */
  bypassToken?: string;
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

function resolveIp(c: any): string {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

function ipMatchesCidr(ip: string, cidr: string): boolean {
  if (ip === cidr) return true;
  const slashIdx = cidr.indexOf('/');
  if (slashIdx === -1) return ip === cidr;
  const prefixBits = parseInt(cidr.slice(slashIdx + 1), 10);
  if (isNaN(prefixBits)) return false;
  const baseIp = cidr.slice(0, slashIdx);
  if (ip.includes(':')) return ipv6InCidr(ip, baseIp, prefixBits);
  return ipv4InCidr(ip, baseIp, prefixBits);
}

function ipv4InCidr(ip: string, base: string, bits: number): boolean {
  const ipN = ipv4ToNumber(ip);
  const baseN = ipv4ToNumber(base);
  if (ipN === null || baseN === null) return false;
  const mask = bits === 0 ? 0 : (~0 >>> 0) << (32 - bits);
  return (ipN & mask) === (baseN & mask);
}

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (let i = 0; i < 4; i++) {
    const octet = parseInt(parts[i]!, 10);
    if (isNaN(octet) || octet < 0 || octet > 255) return null;
    n = (n << 8) | octet;
  }
  return n >>> 0;
}

function ipv6InCidr(ip: string, base: string, bits: number): boolean {
  const ipBytes = ipv6ToBytes(ip);
  const baseBytes = ipv6ToBytes(base);
  if (!ipBytes || !baseBytes) return false;
  const fullBytes = Math.min(Math.ceil(bits / 8), 16);
  for (let i = 0; i < fullBytes; i++) {
    const byteBits = (i < Math.floor(bits / 8)) ? 8 : bits % 8;
    if (byteBits === 0) break;
    const mask = (0xff << (8 - byteBits)) & 0xff;
    if ((ipBytes[i]! & mask) !== (baseBytes[i]! & mask)) return false;
  }
  return true;
}

function ipv6ToBytes(ip: string): Uint8Array | null {
  const norm = ip.toLowerCase();
  const parts = norm.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts[1] ? parts[1].split(':') : [];
  if (left.length + right.length > 7) return null;
  const missing = 8 - left.length - right.length;
  const groups = [...left, ...Array<string>(missing).fill('0'), ...right];
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const val = parseInt(groups[i] || '0', 16);
    if (isNaN(val) || val < 0 || val > 0xffff) return null;
    bytes[i * 2] = (val >> 8) & 0xff;
    bytes[i * 2 + 1] = val & 0xff;
  }
  return bytes;
}

/** Token bucket rate limiter — burst + interval replenishment. */
export function rateLimit(config: RateLimitConfig): MiddlewareHandler {
  const enabled = config.enabled !== false;
  const bypassIps = config.bypassIps ?? [];
  const bypassToken = config.bypassToken;
  const burst = config.burst ?? 10;
  const intervalMs = config.intervalMs ?? 5000;
  const buckets = new Map<string, TokenBucket>();

  for (const cidr of bypassIps) {
    const slashIdx = cidr.indexOf('/');
    if (slashIdx !== -1 && isNaN(parseInt(cidr.slice(slashIdx + 1), 10))) {
      throw new AppError(500, 'BAD_RATE_LIMIT_CONFIG', `Invalid CIDR prefix: "${cidr}"`);
    }
  }

  return async (c, next) => {
    if (!enabled) return next();

    const ip = resolveIp(c);
    if (bypassIps.length > 0) {
      for (const cidr of bypassIps) {
        if (ipMatchesCidr(ip, cidr)) return next();
      }
    }
    if (bypassToken) {
      const headerToken = c.req.header('x-ratelimit-bypass');
      if (headerToken && headerToken === bypassToken) return next();
    }

    const now = Date.now();
    let bucket = buckets.get(ip);
    if (!bucket) {
      bucket = { tokens: burst, lastRefill: now };
      buckets.set(ip, bucket);
    }

    // Replenish: tokens += (elapsed / intervalMs) * burst
    const elapsed = now - bucket.lastRefill;
    bucket.tokens = Math.min(burst, bucket.tokens + (elapsed / intervalMs) * burst);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      throw new AppError(429, 'RATE_LIMITED', `Rate limit exceeded — ${burst} req / ${intervalMs}ms`);
    }

    bucket.tokens -= 1;
    await next();
  };
}
