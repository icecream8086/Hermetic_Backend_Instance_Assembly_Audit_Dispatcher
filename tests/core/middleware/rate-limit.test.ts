import { describe, it, expect } from 'vitest';
import { rateLimit } from '../../../src/core/middleware/rate-limit.ts';

function fakeContext(ip: string) {
  const headers: Record<string, string> = {};
  if (ip) headers['cf-connecting-ip'] = ip;
  return {
    req: { header: (name: string) => headers[name] ?? null },
    header: () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('rateLimit middleware (white-box)', () => {
  it('allows requests within limit', async () => {
    const mw = rateLimit({ windowMs: 60_000, maxRequests: 5 });
    for (let i = 0; i < 5; i++) {
      const c = fakeContext('1.2.3.4');
      let called = false;
      await mw(c, async () => { called = true; });
      expect(called).toBe(true);
    }
  });

  it('blocks when limit exceeded', async () => {
    const mw = rateLimit({ windowMs: 60_000, maxRequests: 2 });
    const c = fakeContext('10.0.0.1');
    await mw(c, async () => {});
    await mw(c, async () => {});

    await expect(mw(c, async () => {})).rejects.toThrow('Too many requests');
  });

  it('tracks different IPs separately', async () => {
    const mw = rateLimit({ windowMs: 60_000, maxRequests: 1 });
    let called = false;
    await mw(fakeContext('ip-a'), async () => {});
    await mw(fakeContext('ip-b'), async () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it('falls back to x-forwarded-for when cf-connecting-ip absent', async () => {
    const mw = rateLimit({ windowMs: 60_000, maxRequests: 1 });
    const c = fakeContext('');
    (c.req as any).header = (name: string) => name === 'x-forwarded-for' ? 'proxy-ip' : null;
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
    const c = fakeContext('ephemeral-ip');
    await mw(c, async () => {});
    // Wait for window to expire
    await new Promise(r => setTimeout(r, 5));
    let called = false;
    await mw(c, async () => { called = true; });
    expect(called).toBe(true);
  });
});
