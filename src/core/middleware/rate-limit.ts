import type { MiddlewareHandler } from 'hono';
import { AppError } from '../types.ts';

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  /** Master kill switch — when false, all requests bypass rate limiting. Default: true. */
  enabled?: boolean;
  /** IPs or CIDRs exempt from rate limiting. Default: undefined (no bypass). */
  bypassIps?: readonly string[];
  /** Shared secret for header-based bypass. Client sends `X-RateLimit-Bypass: <token>`. */
  bypassToken?: string;
}

// ─── CIDR matching (zero-dependency, supports IPv4 and IPv6) ───

/** Check if `ip` is within the CIDR range `cidr` (e.g. "192.168.1.5" in "192.168.1.0/24"). */
function ipMatchesCidr(ip: string, cidr: string): boolean {
  if (ip === cidr) return true; // exact match shortcut

  const slashIdx = cidr.indexOf('/');
  if (slashIdx === -1) return ip === cidr; // no prefix → exact match only

  const prefixBits = parseInt(cidr.slice(slashIdx + 1), 10);
  if (isNaN(prefixBits)) return false;

  const baseIp = cidr.slice(0, slashIdx);
  if (ip.includes(':')) {
    return ipv6InCidr(ip, baseIp, prefixBits);
  }
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
  // Expand :: shorthand
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

// ─── Middleware ───

function resolveIp(c: any): string {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

/**
 * Simple in-memory sliding-window rate limiter.
 *
 * Bypass strategy (checked in order, first match wins):
 *   1. `enabled: false`         → master kill switch
 *   2. Client IP in `bypassIps` → trusted network
 *   3. `X-RateLimit-Bypass` header matches `bypassToken` → shared secret
 *
 * Expired entries are purged lazily on each request — no background timer.
 */
export function rateLimit(config: RateLimitConfig): MiddlewareHandler {
  const enabled = config.enabled !== false; // default true
  const bypassIps = config.bypassIps ?? [];
  const bypassToken = config.bypassToken;
  const hits = new Map<string, number[]>();

  // Warmup: validate CIDRs at construction so bad config fails fast
  for (const cidr of bypassIps) {
    const slashIdx = cidr.indexOf('/');
    if (slashIdx !== -1 && isNaN(parseInt(cidr.slice(slashIdx + 1), 10))) {
      throw new AppError(500, 'BAD_RATE_LIMIT_CONFIG', `Invalid CIDR prefix in RATE_LIMIT_BYPASS_IPS: "${cidr}"`);
    }
  }

  return async (c, next) => {
    // ── Bypass checks ──
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

    // ── Rate limit enforcement ──
    const now = Date.now();
    const cutoff = now - config.windowMs;

    // Lazy cleanup: purge fully-expired IPs from the map
    for (const [key, timestamps] of hits) {
      const valid = timestamps.filter((t) => t > cutoff);
      if (valid.length === 0) hits.delete(key);
      else if (valid.length < timestamps.length) hits.set(key, valid);
    }

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
