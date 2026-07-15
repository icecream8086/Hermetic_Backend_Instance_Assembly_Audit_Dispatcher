import { join } from 'node:path'; import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach } from 'vitest';
import { FileKVAtomicStore } from '../../../src/core/store/adapters/file-kv.ts';
import { idempotency } from '../../../src/core/middleware/idempotency.ts';

function store() { return new FileKVAtomicStore(join(tmpdir(), 'hbi-idem-' + crypto.randomUUID().slice(0, 8))); }

function fakeCtx(overrides?: { stores?: any; headers?: Record<string, string>; res?: any }) {
  return {
    req: {
      header(name: string) { return overrides?.headers?.[name]; },
    },
    var: { stores: overrides?.stores ?? {} },
    res: overrides?.res ?? { status: 200, clone() { return { json: async () => ({ ok: true }) }; } },
  } as any;
}

describe('idempotency middleware', () => {
  let atomic: ReturnType<typeof store>;
  let mw: ReturnType<typeof idempotency>;

  beforeEach(() => {
    atomic = store();
    mw = idempotency();
  });

  it('passes through when no Idempotency-Key header', async () => {
    const ctx = fakeCtx({ stores: { atomic } });
    let nextCalled = false;
    await mw(ctx, async () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  it('returns cached response when key exists in store', async () => {
    const storageKey = 'idempotency:my-key';
    await atomic.set(storageKey, JSON.stringify({ status: 201, body: { ok: true, data: 'cached' } }), null);

    const ctx = fakeCtx({
      stores: { atomic },
      headers: { 'Idempotency-Key': 'my-key' },
    });
    let nextCalled = false;
    const result = await mw(ctx, async () => { nextCalled = true; }) as Response;
    expect(nextCalled).toBe(false);
    expect(result).toBeInstanceOf(Response);
    const body = await result.json();
    expect(result.status).toBe(201);
    expect(body.data).toBe('cached');
  });

  it('executes request and stores response when key is new', async () => {
    const ctx = fakeCtx({
      stores: { atomic },
      headers: { 'Idempotency-Key': 'new-key' },
    });
    ctx.json = (body: any, status: number) => body;

    let nextCalled = false;
    await mw(ctx, async () => { nextCalled = true; });
    expect(nextCalled).toBe(true);

    // Verify response was stored
    const stored = await atomic.get<string>('idempotency:new-key');
    expect(stored).not.toBeNull();
  });

  it('does not store response for server errors (5xx)', async () => {
    const ctx = fakeCtx({
      stores: { atomic },
      headers: { 'Idempotency-Key': 'err-key' },
      res: { status: 500, clone() { return { json: async () => ({ error: 'fail' }) }; } },
    });

    await mw(ctx, async () => {});
    const stored = await atomic.get<string>('idempotency:err-key');
    expect(stored).toBeNull();
  });

  // ── FIXED: corrupted stored data → gracefully falls through to re-execute ──
  it('corrupted stored value falls through instead of crashing', async () => {
    await atomic.set('idempotency:bad-key', 'not-valid-json{{{', null);
    const ctx = fakeCtx({
      stores: { atomic },
      headers: { 'Idempotency-Key': 'bad-key' },
    });
    let nextCalled = false;
    // Now gracefully falls through instead of throwing SyntaxError
    await mw(ctx, async () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  // ── FIXED: non-JSON response → skips caching instead of crashing ──
  it('non-JSON response skips caching gracefully', async () => {
    const ctx = fakeCtx({
      stores: { atomic },
      headers: { 'Idempotency-Key': 'plain-key' },
      res: {
        status: 200,
        clone() {
          return { json: async () => { throw new SyntaxError('Not JSON'); } };
        },
      },
    });
    let nextCalled = false;
    await mw(ctx, async () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    // Response was not cached (non-JSON body)
    const stored = await atomic.get<string>('idempotency:plain-key');
    expect(stored).toBeNull();
  });
});
