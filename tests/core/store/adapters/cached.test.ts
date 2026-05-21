import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CachedAtomicStore } from '../../../../src/core/store/adapters/cached.ts';
import type { IAtomicStore, IStoreTransaction } from '../../../../src/core/store/interfaces.ts';
import type { VersionId } from '../../../../src/core/brand.ts';

// ─── In-memory IAtomicStore for testing ───

class InMemoryAtomicStore implements IAtomicStore {
  readonly data = new Map<string, { value: unknown; version: VersionId }>();
  private versionCounter = 0;

  async get<T>(key: string): Promise<{ value: T; version: VersionId } | null> {
    const entry = this.data.get(key);
    if (!entry) return null;
    return { value: entry.value as T, version: entry.version };
  }

  async set<T>(key: string, value: T, expectedVersion: VersionId | null, _ttlSeconds?: number): Promise<VersionId | null> {
    const current = this.data.get(key);
    const curVer = current?.version ?? null;
    if (expectedVersion !== curVer) return null;

    const newVersion = String(++this.versionCounter) as VersionId;
    this.data.set(key, { value, version: newVersion });
    return newVersion;
  }

  async transact<T>(action: (txn: IStoreTransaction) => Promise<T>): Promise<T> {
    const txn: IStoreTransaction = {
      get: async <V>(key: string) => {
        const entry = this.data.get(key);
        return entry?.value as V | null;
      },
      set: async <V>(key: string, value: V, _ttlSeconds?: number) => {
        const newVersion = String(++this.versionCounter) as VersionId;
        this.data.set(key, { value, version: newVersion });
      },
    };
    return action(txn);
  }

  /** Exposed for test inspection: get raw version of a key. */
  rawVersion(key: string): VersionId | undefined {
    return this.data.get(key)?.version;
  }
}

describe('CachedAtomicStore', () => {
  let primary: InMemoryAtomicStore;
  let cache: InMemoryAtomicStore;
  let store: CachedAtomicStore;

  // Use a long TTL so entries don't expire during test unless we test expiry explicitly
  const TEST_TTL = 300_000;

  beforeEach(() => {
    primary = new InMemoryAtomicStore();
    cache = new InMemoryAtomicStore();
    store = new CachedAtomicStore(primary, cache, TEST_TTL);
  });

  describe('get / set', () => {
    it('writes to primary and populates cache on create', async () => {
      const ver = await store.set('k', 'hello', null);
      expect(ver).toBeTruthy();

      // Primary has the data
      const primaryVal = await primary.get<string>('k');
      expect(primaryVal!.value).toBe('hello');

      // Cache has the wrapped entry
      const cacheVal = await cache.get<{ data: string; cachedAt: number }>('k');
      expect(cacheVal).not.toBeNull();
      expect(cacheVal!.value.data).toBe('hello');
      expect(typeof cacheVal!.value.cachedAt).toBe('number');
    });

    it('read returns from cache on second read', async () => {
      await store.set('k', 'cached-value', null);

      // First read may hit primary or cache depending on timing;
      // second read should be a cache hit.
      await store.get<string>('k'); // warm the cache if needed
      const result = await store.get<string>('k');

      expect(result).not.toBeNull();
      expect(result!.value).toBe('cached-value');
    });

    it('read-through populates cache on miss', async () => {
      // Write directly to primary (bypassing cache)
      await primary.set('k', 'direct', null);

      // Read through cached store — should populate cache
      const result = await store.get<string>('k');
      expect(result!.value).toBe('direct');

      // Cache now has the entry
      const cacheVal = await cache.get<{ data: string }>('k');
      expect(cacheVal!.value.data).toBe('direct');
    });

    it('returns latest value from primary after cache TTL expiry', async () => {
      const shortTtl = new CachedAtomicStore(primary, cache, 10); // 10ms TTL

      // Write to primary only
      await primary.set('k', 'stale', null);

      // First read populates cache with 'stale'
      await shortTtl.get<string>('k');

      // Update primary with new value
      await primary.set('k', 'fresh', await primary.rawVersion('k')!);

      // Wait for TTL to expire
      await new Promise(r => setTimeout(r, 20));

      // Read should bypass cache and get fresh value
      const result = await shortTtl.get<string>('k');
      expect(result!.value).toBe('fresh');
    });

    it('set with version conflict returns null and does not write cache', async () => {
      await primary.set('k', 'original', null);

      // Attempt write with wrong version
      const result = await store.set('k', 'overwrite', 'wrong-version' as VersionId);
      expect(result).toBeNull();

      // Cache should NOT contain the write
      const cacheVal = await cache.get('k');
      expect(cacheVal).toBeNull();
    });

    it('version changes on each successful set', async () => {
      const v1 = await store.set('k', 1, null);
      const v2 = await store.set('k', 2, v1);
      const v3 = await store.set('k', 3, v2);

      expect(v1).toBeTruthy();
      expect(v2).toBeTruthy();
      expect(v3).toBeTruthy();
      expect(v1).not.toBe(v2);
      expect(v2).not.toBe(v3);
    });
  });

  describe('cache hit vs miss', () => {
    it('returns null for non-existent key', async () => {
      const result = await store.get('nonexistent');
      expect(result).toBeNull();
    });

    it('cache miss propagates primary null return', async () => {
      // Nothing in primary or cache
      const result = await store.get('missing');
      expect(result).toBeNull();

      // Cache should not have written anything
      const cacheVal = await cache.get('missing');
      expect(cacheVal).toBeNull();
    });
  });

  describe('transact', () => {
    it('delegates to primary, does not touch cache', async () => {
      const result = await store.transact(async (txn) => {
        await txn.set('txn-key', 'txn-val');
        return 99;
      });

      expect(result).toBe(99);

      // Primary has the data
      const primaryVal = await primary.get<string>('txn-key');
      expect(primaryVal!.value).toBe('txn-val');

      // Cache should NOT have the data (transact bypasses cache)
      const cacheVal = await cache.get('txn-key');
      expect(cacheVal).toBeNull();
    });
  });

  describe('cache write behaviour', () => {
    it('set populates cache asynchronously (fire-and-forget)', async () => {
      const setSpy = vi.spyOn(cache, 'set');

      const ver = await store.set('k', 'fire-and-forget', null);
      expect(ver).toBeTruthy();

      const primaryVal = await primary.get<string>('k');
      expect(primaryVal!.value).toBe('fire-and-forget');

      expect(setSpy).toHaveBeenCalledWith('k', expect.objectContaining({ data: 'fire-and-forget' }), null, undefined);
    });
  });

  describe('TTL passthrough', () => {
    it('passes cacheTtlSeconds to cache.set() on write-through', async () => {
      const ttlCache = new CachedAtomicStore(primary, cache, 300_000, 120);
      const setSpy = vi.spyOn(cache, 'set');

      await ttlCache.set('k', 'ttl-value', null);

      expect(setSpy).toHaveBeenCalledWith('k', expect.anything(), null, 120);
    });

    it('passes cacheTtlSeconds to cache.set() on read-through', async () => {
      const ttlCache = new CachedAtomicStore(primary, cache, 300_000, 300);
      const setSpy = vi.spyOn(cache, 'set');

      await primary.set('k2', 'read-ttl', null);
      await ttlCache.get('k2');

      expect(setSpy).toHaveBeenCalledWith('k2', expect.anything(), null, 300);
    });

    it('does not pass ttl when cacheTtlSeconds is not configured', async () => {
      const setSpy = vi.spyOn(cache, 'set');

      await store.set('k3', 'no-ttl', null);

      expect(setSpy).toHaveBeenCalledWith('k3', expect.anything(), null, undefined);
    });
  });
});
