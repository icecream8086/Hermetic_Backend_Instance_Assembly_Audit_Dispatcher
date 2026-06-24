import { join } from 'node:path'; import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach } from 'vitest';
import { FileKVAtomicStore } from '../../../src/core/store/adapters/file-kv.ts';
import { RequestCachedAtomicStore } from '../../../src/core/store/request-cache.ts';
import type { VersionId } from '../../../src/core/brand.ts';

function store() { return new FileKVAtomicStore(join(tmpdir(), 'hbi-rcache-' + crypto.randomUUID().slice(0, 8))); }

describe('RequestCachedAtomicStore', () => {
  let inner: FileKVAtomicStore;
  let cached: RequestCachedAtomicStore;

  beforeEach(() => {
    inner = store();
    cached = new RequestCachedAtomicStore(inner);
  });

  it('serves second get() from cache without hitting inner store', async () => {
    await inner.set('key1', 'value1', null);
    const r1 = await cached.get<string>('key1');
    expect(r1!.value).toBe('value1');

    // Mutate inner store directly
    await inner.set('key1', 'changed', r1!.version);
    // Second get returns cached value, not the changed one
    const r2 = await cached.get<string>('key1');
    expect(r2!.value).toBe('value1'); // cached
  });

  it('set() invalidates cache for that key', async () => {
    await inner.set('key1', 'v1', null);
    const first = await cached.get<string>('key1');
    expect(first!.value).toBe('v1');

    // Set via cached (cache evicted), get reads fresh from inner
    await cached.set('key1', 'v2', first!.version);
    const r = await cached.get<string>('key1');
    expect(r!.value).toBe('v2');
  });

  it('transact() clears entire cache', async () => {
    await inner.set('key1', 'v1', null);
    await inner.set('key2', 'v2', null);
    await cached.get<string>('key1');
    await cached.get<string>('key2');

    await cached.transact(async (txn) => {
      txn.set('key3', 'v3');
    });

    // Cache cleared — next get hits inner
    const r1 = await cached.get<string>('key1');
    expect(r1!.value).toBe('v1'); // re-read from inner
  });

  it('transact reads current state from inner', async () => {
    await cached.set('key1', 'before', null);

    const result = await cached.transact(async (txn) => {
      const v1 = await txn.get<string>('key1');
      const v2 = await txn.get<string>('key2');
      return { v1: v1 ?? 'none', v2: v2 ?? 'none' };
    });
    expect(result.v1).toBe('before');
    expect(result.v2).toBe('none');
  });

  it('invalidateCache removes single key', async () => {
    await inner.set('key1', 'v1', null);
    await inner.set('key2', 'v2', null);
    await cached.get<string>('key1');
    await cached.get<string>('key2');

    // Mutate key1 in inner
    const entry = await inner.get<string>('key1');
    await inner.set('key1', 'changed', entry!.version);

    await cached.invalidateCache('key1');

    const r1 = await cached.get<string>('key1');
    expect(r1!.value).toBe('changed');
    const r2 = await cached.get<string>('key2');
    expect(r2!.value).toBe('v2'); // key2 still cached
  });

  it('returns null for non-existent key (no cache pollution)', async () => {
    const r1 = await cached.get<string>('nonexistent');
    expect(r1).toBeNull();
    // Second call also returns null from cache
    const r2 = await cached.get<string>('nonexistent');
    expect(r2).toBeNull();
  });

  // ── FIXED: transact() keeps cache on failure, clears on success ──
  it('transact() preserves cache when inner throws', async () => {
    await inner.set('key1', 'v1', null);

    let getCount = 0;
    const spyInner = {
      get: async <T>(key: string) => { getCount++; return inner.get<T>(key); },
      set: inner.set.bind(inner),
      transact: async () => { throw new Error('BOOM'); },
      invalidateCache: async () => {},
    };
    const badCache = new RequestCachedAtomicStore(spyInner as any);
    await badCache.get<string>('key1'); // populate badCache's cache

    try { await badCache.transact(async () => {}); } catch {}

    // Cache preserved — no re-read from inner needed
    const r = await badCache.get<string>('key1');
    expect(r!.value).toBe('v1');
    expect(getCount).toBe(1); // only the initial populate get
  });
});
