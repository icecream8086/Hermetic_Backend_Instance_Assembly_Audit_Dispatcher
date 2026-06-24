import { describe, it, expect } from 'vitest';
import { jsonDepthLimit } from '../../../src/core/middleware/security.ts';

function fakeCtx(overrides?: { ct?: string; body?: any }) {
  const ct = overrides?.ct ?? 'application/json';
  let jsonFn = async () => overrides?.body ?? {};
  return {
    req: {
      header(name: string) { return name === 'content-type' ? ct : null; },
      json: async () => jsonFn(),
    },
    json(body: any, status: number) { return { body, status }; },
  } as any;
}

describe('jsonDepthLimit middleware', () => {
  it('passes through when content-type is not JSON', async () => {
    const mw = jsonDepthLimit(5);
    const ctx = fakeCtx({ ct: 'text/plain' });
    let called = false;
    await mw(ctx, async () => { called = true; });
    expect(called).toBe(true);
  });

  it('passes shallow JSON (depth 1)', async () => {
    const mw = jsonDepthLimit(5);
    const ctx = fakeCtx({ body: { a: 1, b: 'two' } });
    let called = false;
    await mw(ctx, async () => { called = true;
      await ctx.req.json(); // trigger depth check
    });
    expect(called).toBe(true);
  });

  it('passes nested JSON within limit (depth 3)', async () => {
    const mw = jsonDepthLimit(5);
    const ctx = fakeCtx({ body: { a: { b: { c: 1 } } } });
    let called = false;
    await mw(ctx, async () => { called = true;
      await ctx.req.json();
    });
    expect(called).toBe(true);
  });

  it('rejects JSON exceeding depth limit', async () => {
    const mw = jsonDepthLimit(2);
    const ctx = fakeCtx({ body: { a: { b: { c: { d: 1 } } } } }); // depth 4
    let responseJson: any = null;
    ctx.json = (body: any, status: number) => { responseJson = { body, status }; return responseJson; };

    await mw(ctx, async () => {
      await ctx.req.json(); // should throw BodyDepthError
    });
    expect(responseJson).not.toBeNull();
    expect(responseJson.status).toBe(400);
    expect(responseJson.body.error.code).toBe('BODY_TOO_DEEP');
  });

  it('rejects deeply nested arrays', async () => {
    const mw = jsonDepthLimit(3);
    const ctx = fakeCtx({ body: [[[[1]]]] }); // depth 4
    let responseJson: any = null;
    ctx.json = (body: any, status: number) => { responseJson = { body, status }; return responseJson; };

    await mw(ctx, async () => {
      await ctx.req.json();
    });
    expect(responseJson.status).toBe(400);
  });

  it('uses default max depth of 10', async () => {
    const mw = jsonDepthLimit();
    // Build object with depth 9 (within default limit of 10)
    let obj: any = 1;
    for (let i = 0; i < 9; i++) obj = { v: obj };
    const ctx = fakeCtx({ body: obj });
    let called = false;
    await mw(ctx, async () => { called = true; await ctx.req.json(); });
    expect(called).toBe(true);
  });
});
