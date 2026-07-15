import type { IAtomicStore, IStoreTransaction } from '../interfaces.ts';
import { createVersionId, type VersionId } from '../../brand.ts';
import type { AtomicStoreMetrics } from '../metrics.ts';

const DEFAULT_CACHE_TTL_MS = 300_000; // 5 min — data barely changes, refresh on demand

/**
 * Wrapper stored in cache.
 *
 * `coordinatorVersion` carries the DO's version so that subsequent
 * read-modify-write callers can pass it back as expectedVersion for OCC.
 * Without this, a KV cache hit returns the KV version, but the DO
 * expects its own version — every read-modify-write would conflict.
 */
interface CacheEntry<T> {
  data: T;
  cachedAt: number;
  coordinatorVersion: string | null;
}

/**
 * Simple Bloom filter for fast negative lookup — avoids redundant store reads
 * for keys that have never been written.
 */
class BloomFilter {
  static readonly #SIZE = 524288;
  static readonly #SEEDS = [0x9e3779b9, 0xabcdef01, 0x12345678];
  readonly #bits: Uint8Array;

  public constructor() {
    this.#bits = new Uint8Array(Math.ceil(BloomFilter.#SIZE / 8));
  }

  public add(key: string): void {
    for (const seed of BloomFilter.#SEEDS) {
      const idx = this.#hash(key, seed) % BloomFilter.#SIZE;
      const i = idx >> 3;
      this.#bits[i] = (this.#bits[i] ?? 0) | (1 << (idx & 7));
    }
  }

  public mightContain(key: string): boolean {
    for (const seed of BloomFilter.#SEEDS) {
      const idx = this.#hash(key, seed) % BloomFilter.#SIZE;
      if (!((this.#bits[idx >> 3] ?? 0) & (1 << (idx & 7)))) return false;
    }
    return true;
  }

  #hash(key: string, seed: number): number {
    let h = seed;
    for (let i = 0; i < key.length; i++) {
      h = Math.imul(h ^ key.charCodeAt(i), 0x9e3779b9);
    }
    return h >>> 0;
  }
}

/**
 * Two-layer store: coordinator (DO) for OCC + lifecycle, store (KV) for durability.
 *
 * - `set`: coordinator validates OCC → store persists (sync).
 * - `get`: store first → miss → coordinator fallback → populate store.
 * - `transact`: runs on coordinator (atomic multi-key); results NOT written to store
 *   (transact is used only for index updates which are rebuilt on demand).
 *
 * This keeps reads fast (no DO round-trip on cache hit) while writes are
 * durably persisted to KV after DO coordination.
 *
 * 参数命名区分:
 *   `readTtlMs` — 读缓存 TTL（毫秒），`get()` 命中 KV 后多长时间内认为有效
 *   `storeTtlSeconds` — 存储侧 TTL（秒），传给底层 KV 的服务器端过期时间
 */
export class CachedAtomicStore implements IAtomicStore {
  /**
   * Last-known store (KV) version per key.
   *
   * Avoids the redundant `store.get()` before `store.set()` on every write:
   * the coordinator (DO) already validated OCC, so cache-layer OCC is only
   * needed to prevent clobbering a concurrent cache write from another
   * Worker instance — a rare edge case.  In steady state we save one KV
   * round-trip per write; on cold start the first write per key does the
   * full read-then-write to prime the map.
   */
  readonly #storeVersion = new Map<string, VersionId | null>();
  readonly #bloom = new BloomFilter();

  public constructor(
    private readonly coordinator: IAtomicStore,
    private readonly store: IAtomicStore,
    private readonly readTtlMs: number = DEFAULT_CACHE_TTL_MS,
    private readonly storeTtlSeconds?: number,
    public readonly metrics?: AtomicStoreMetrics,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- interface contract requires generics
  public async get<T>(key: string): Promise<{ value: T; version: VersionId } | null> {
    this.metrics?.recordGet();

    // Bloom gate: skip store read for keys we've never seen
    if (this.#bloom.mightContain(key)) {
      const hit = await this.store.get<CacheEntry<T>>(key);
      if (hit !== null) {
        const entry = hit.value;
        if (Date.now() - entry.cachedAt < this.readTtlMs) {
          // Tombstone within TTL — data genuinely absent
          if (entry.data === null) return null;
          this.metrics?.recordHit();
          if (entry.coordinatorVersion !== null) {
            return { value: entry.data, version: createVersionId(entry.coordinatorVersion) };
          }
        }
      }
    }

    this.metrics?.recordMiss();
    const miss = await this.coordinator.get<T>(key);
    if (miss !== null) {
      this.#bloom.add(key);
      const cacheEntry = { data: miss.value, cachedAt: Date.now(), coordinatorVersion: miss.version } satisfies CacheEntry<T>;
      const lastVer = this.#storeVersion.get(key) ?? null;
      void this.store.set(key, cacheEntry, lastVer, this.storeTtlSeconds)
        .then(v => { if (v) this.#storeVersion.set(key, v); })
        .then(undefined, () => { /* noop */ });
    }
    return miss;
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- interface contract requires generics
  public async set<T>(key: string, value: T, expectedVersion: VersionId | null, ttlSeconds?: number): Promise<VersionId | null> {
    this.metrics?.recordSet();
    const version = await this.coordinator.set(key, value, expectedVersion, ttlSeconds);
    if (version !== null) {
      this.#bloom.add(key);
      const lastVer = this.#storeVersion.get(key) ?? null;
      const cacheEntry = { data: value, cachedAt: Date.now(), coordinatorVersion: version } satisfies CacheEntry<T>;
      const storeVer = await this.store.set(key, cacheEntry, lastVer, this.storeTtlSeconds);
      if (storeVer) {
        this.#storeVersion.set(key, storeVer);
      } else {
        // OCC conflict on cache layer — fall back to read-then-write.
        const current = await this.store.get<CacheEntry<T>>(key);
        const currentVer = current?.version ?? null;
        const retryVer = await this.store.set(key, cacheEntry, currentVer, this.storeTtlSeconds);
        if (retryVer) this.#storeVersion.set(key, retryVer);
      }
    }
    return version;
  }

  public async transact<T>(action: (txn: IStoreTransaction) => Promise<T>): Promise<T> {
    return this.coordinator.transact(action);
  }

  public async invalidateCache(key: string): Promise<void> {
    let current: { value: CacheEntry<unknown>; version: VersionId } | null;
    try { current = await this.store.get<CacheEntry<unknown>>(key); } catch {
      console.debug("");
    }
    if (current !== null) {
      let ver: VersionId | null;
      try {
        ver = await this.store.set(
          key,
          { data: null, cachedAt: 0, coordinatorVersion: null },
          current.version,
        );
      } catch { ver = null; }
      if (ver) this.#storeVersion.set(key, ver);
    }
  }
}
