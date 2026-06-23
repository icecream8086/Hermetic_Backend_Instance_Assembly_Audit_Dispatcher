import { describe, it, expect } from 'vitest';
import { rateLimit } from '../../../src/core/middleware/rate-limit.ts';

function fakeCtx(overrides?: { ip?: string; headers?: Record<string, string> }) {
  const headers: Record<string, string> = { ...overrides?.headers };
  if (overrides?.ip) headers['cf-connecting-ip'] = overrides.ip;
  return {
    req: {
      header(name: string) {
        if (headers[name]) return headers[name];
        return null;
      },
    },
  } as any;
}

async function call(mw: ReturnType<typeof rateLimit>, ctx?: any): Promise<{ nextCalled: boolean; error?: any }> {
  let nextCalled = false;
  let error: any;
  try {
    await mw(ctx ?? fakeCtx(), async () => { nextCalled = true; });
  } catch (e) { error = e; }
  return { nextCalled, error };
}

describe('rateLimit middleware', () => {
  // ─── existing: standard enforcement ───
  describe('standard enforcement', () => {
    it('allows requests within limit', async () => {
      const mw = rateLimit({ windowMs: 60_000, maxRequests: 5 });
      for (let i = 0; i < 5; i++) {
        const c = fakeCtx({ ip: '1.2.3.4' });
        let called = false;
        await mw(c, async () => { called = true; });
        expect(called).toBe(true);
      }
    });

    it('blocks when limit exceeded', async () => {
      const mw = rateLimit({ windowMs: 60_000, maxRequests: 2 });
      const c = fakeCtx({ ip: '10.0.0.1' });
      await mw(c, async () => {});
      await mw(c, async () => {});
      await expect(mw(c, async () => {})).rejects.toThrow('Too many requests');
    });

    it('tracks different IPs separately', async () => {
      const mw = rateLimit({ windowMs: 60_000, maxRequests: 1 });
      let called = false;
      await mw(fakeCtx({ ip: 'ip-a' }), async () => {});
      await mw(fakeCtx({ ip: 'ip-b' }), async () => { called = true; });
      expect(called).toBe(true);
    });

    it('falls back to x-forwarded-for when cf-connecting-ip absent', async () => {
      const mw = rateLimit({ windowMs: 60_000, maxRequests: 1 });
      const c = fakeCtx({ headers: { 'x-forwarded-for': 'proxy-ip' } });
      await mw(c, async () => {});
      await expect(mw(c, async () => {})).rejects.toThrow('Too many requests');
    });

    it('uses "unknown" when no IP headers present', async () => {
      const mw = rateLimit({ windowMs: 60_000, maxRequests: 1 });
      const c = { req: { header: () => null } } as any;
      await mw(c, async () => {});
      await expect(mw(c, async () => {})).rejects.toThrow('Too many requests');
    });

    it('purges expired entries lazily', async () => {
      const mw = rateLimit({ windowMs: 1, maxRequests: 1 });
      const c = fakeCtx({ ip: 'ephemeral-ip' });
      await mw(c, async () => {});
      await new Promise(r => setTimeout(r, 5));
      let called = false;
      await mw(c, async () => { called = true; });
      expect(called).toBe(true);
    });
  });

  // ─── NEW: kill switch ───
  describe('kill switch (enabled)', () => {
    it('bypasses all when enabled is false', async () => {
      const mw = rateLimit({ windowMs: 1000, maxRequests: 1, enabled: false });
      // Fill quota, should still pass
      for (let i = 0; i < 10; i++) {
        const { nextCalled } = await call(mw);
        expect(nextCalled).toBe(true);
      }
    });

    it('enforces when enabled is true (explicit)', async () => {
      const mw = rateLimit({ windowMs: 60_000, maxRequests: 1, enabled: true });
      await call(mw);
      const { nextCalled, error } = await call(mw);
      expect(nextCalled).toBe(false);
      expect(error.statusCode).toBe(429);
      expect(error.code).toBe('RATE_LIMITED');
    });

    it('enforces when enabled is not set (defaults true)', async () => {
      const mw = rateLimit({ windowMs: 60_000, maxRequests: 1 });
      await call(mw);
      const { nextCalled } = await call(mw);
      expect(nextCalled).toBe(false);
    });
  });

  // ─── NEW: IP allowlist ───
  describe('IP allowlist', () => {
    it('bypasses when client IP exactly matches bypassIps entry', async () => {
      const mw = rateLimit({ windowMs: 60_000, maxRequests: 1, bypassIps: ['10.0.0.5'] });
      await call(mw, fakeCtx({ ip: 'other' })); // fill quota for other IP
      const { nextCalled } = await call(mw, fakeCtx({ ip: '10.0.0.5' }));
      expect(nextCalled).toBe(true);
    });

    it('bypasses when client IP is in CIDR range', async () => {
      const mw = rateLimit({ windowMs: 60_000, maxRequests: 1, bypassIps: ['192.168.1.0/24'] });
      await call(mw, fakeCtx({ ip: 'other' }));
      // 3 IPs all in range — each should bypass via its own fakeCtx call
      for (const ip of ['192.168.1.1', '192.168.1.128', '192.168.1.255']) {
        const { nextCalled } = await call(mw, fakeCtx({ ip }));
        expect(nextCalled).toBe(true);
      }
    });

    it('does NOT bypass when IP is outside CIDR range', async () => {
      const mw = rateLimit({ windowMs: 60_000, maxRequests: 1, bypassIps: ['10.0.0.0/8'] });
      // Fill quota for this specific IP (192.168.1.1 is NOT in 10.0.0.0/8)
      const ctx = fakeCtx({ ip: '192.168.1.1' });
      await call(mw, ctx);
      const { nextCalled } = await call(mw, ctx);
      expect(nextCalled).toBe(false);
    });

    it('supports IPv6 loopback bypass', async () => {
      const mw = rateLimit({ windowMs: 60_000, maxRequests: 1, bypassIps: ['::1'] });
      await call(mw, fakeCtx({ ip: 'other' }));
      const { nextCalled } = await call(mw, fakeCtx({ ip: '::1' }));
      expect(nextCalled).toBe(true);
    });

    it('supports IPv6 CIDR (fe80::/10)', async () => {
      const mw = rateLimit({ windowMs: 60_000, maxRequests: 1, bypassIps: ['fe80::/10'] });
      await call(mw, fakeCtx({ ip: 'other' }));
      const { nextCalled } = await call(mw, fakeCtx({ ip: 'fe80::1' }));
      expect(nextCalled).toBe(true);
    });

    it('/32 CIDR is exact IPv4 match', async () => {
      const mw = rateLimit({ windowMs: 60_000, maxRequests: 1, bypassIps: ['172.16.0.1/32'] });
      // 172.16.0.1 matches /32 — always bypasses
      expect((await call(mw, fakeCtx({ ip: '172.16.0.1' }))).nextCalled).toBe(true);
      expect((await call(mw, fakeCtx({ ip: '172.16.0.1' }))).nextCalled).toBe(true);
      // 172.16.0.2 does NOT match /32 — rate limited after first request
      const noMatchCtx = fakeCtx({ ip: '172.16.0.2' });
      await call(mw, noMatchCtx);
      expect((await call(mw, noMatchCtx)).nextCalled).toBe(false);
    });
  });

  // ─── NEW: shared token bypass ───
  describe('shared token bypass', () => {
    it('bypasses when X-RateLimit-Bypass header matches bypassToken', async () => {
      const mw = rateLimit({ windowMs: 60_000, maxRequests: 1, bypassToken: 'secret123' });
      await call(mw);
      const { nextCalled } = await call(mw, fakeCtx({ headers: { 'x-ratelimit-bypass': 'secret123' } }));
      expect(nextCalled).toBe(true);
    });

    it('does NOT bypass when header token is wrong', async () => {
      const mw = rateLimit({ windowMs: 60_000, maxRequests: 1, bypassToken: 'secret123' });
      await call(mw);
      const { nextCalled } = await call(mw, fakeCtx({ headers: { 'x-ratelimit-bypass': 'wrong' } }));
      expect(nextCalled).toBe(false);
    });

    it('does NOT bypass when bypassToken is not configured', async () => {
      const mw = rateLimit({ windowMs: 60_000, maxRequests: 1 });
      await call(mw);
      const { nextCalled } = await call(mw, fakeCtx({ headers: { 'x-ratelimit-bypass': 'anything' } }));
      expect(nextCalled).toBe(false);
    });
  });

  // ─── NEW: bypass priority ───
  describe('bypass priority (kill switch > IP > token)', () => {
    it('kill switch disables everything', async () => {
      const mw = rateLimit({
        windowMs: 60_000, maxRequests: 1,
        enabled: false, bypassIps: ['10.0.0.0/8'], bypassToken: 'secret',
      });
      const { nextCalled } = await call(mw, fakeCtx({ ip: '1.2.3.4' }));
      expect(nextCalled).toBe(true);
    });

    it('IP bypass works without token when token also configured', async () => {
      const mw = rateLimit({
        windowMs: 60_000, maxRequests: 1,
        bypassIps: ['172.16.0.1'], bypassToken: 'secret',
      });
      await call(mw, fakeCtx({ ip: 'other' }));
      const { nextCalled } = await call(mw, fakeCtx({ ip: '172.16.0.1' }));
      expect(nextCalled).toBe(true);
    });
  });

  // ─── NEW: construction validation ───
  describe('construction validation', () => {
    it('throws on invalid CIDR prefix', () => {
      expect(() => rateLimit({
        windowMs: 1000, maxRequests: 10,
        bypassIps: ['192.168.1.0/abc'],
      })).toThrow('Invalid CIDR prefix');
    });

    it('accepts valid CIDRs', () => {
      expect(() => rateLimit({
        windowMs: 1000, maxRequests: 10,
        bypassIps: ['10.0.0.0/8', '::1/128', '127.0.0.1'],
      })).not.toThrow();
    });
  });
});
