import type { IAtomicStore, IStoreTransaction } from '../interfaces.ts';
import type { VersionId } from '../../brand.ts';
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
 * Two-layer store: coordinator (DO) for OCC + lifecycle, store (KV) for durability.
 *
 * - `set`: coordinator validates OCC → store persists (sync).
 * - `get`: store first → miss → coordinator fallback → populate store.
 * - `transact`: runs on coordinator (atomic multi-key); results NOT written to store
 *   (transact is used only for index updates which are rebuilt on demand).
 *
 * This keeps reads fast (no DO round-trip on cache hit) while writes are
 * durably persisted to KV after DO coordination.
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

  constructor(
    private readonly coordinator: IAtomicStore,
    private readonly store: IAtomicStore,
    private readonly cacheTtlMs: number = DEFAULT_CACHE_TTL_MS,
    private readonly cacheTtlSeconds?: number,
    readonly metrics?: AtomicStoreMetrics,
  ) {}

  async get<T>(key: string): Promise<{ value: T; version: VersionId } | null> {
    this.metrics?.recordGet();
    const hit = await this.store.get<CacheEntry<T>>(key);
    if (hit !== null) {
      const entry = hit.value;
      if (Date.now() - entry.cachedAt < this.cacheTtlMs) {
        // Tombstone within TTL — data genuinely absent
        if (entry.data === null) return null;
        this.metrics?.recordHit();
        if (entry.coordinatorVersion !== null) {
          return { value: entry.data, version: entry.coordinatorVersion as VersionId };
        }
      }
    }

    this.metrics?.recordMiss();
    const miss = await this.coordinator.get<T>(key);
    if (miss !== null) {
      const cacheEntry = { data: miss.value, cachedAt: Date.now(), coordinatorVersion: miss.version as string } satisfies CacheEntry<T>;
      const lastVer = this.#storeVersion.get(key) ?? null;
      void this.store.set(key, cacheEntry, lastVer, this.cacheTtlSeconds)
        .then(v => { if (v) this.#storeVersion.set(key, v); })
        .catch(() => {});
    }
    return miss;
  }

  async set<T>(key: string, value: T, expectedVersion: VersionId | null, ttlSeconds?: number): Promise<VersionId | null> {
    this.metrics?.recordSet();
    const version = await this.coordinator.set(key, value, expectedVersion, ttlSeconds);
    if (version !== null) {
      const lastVer = this.#storeVersion.get(key) ?? null;
      const cacheEntry = { data: value, cachedAt: Date.now(), coordinatorVersion: version as string } satisfies CacheEntry<T>;
      const storeVer = await this.store.set(key, cacheEntry, lastVer, this.cacheTtlSeconds);
      if (storeVer) {
        this.#storeVersion.set(key, storeVer);
      } else {
        // OCC conflict on cache layer — fall back to read-then-write.
        const current = await this.store.get<CacheEntry<T>>(key);
        const currentVer = current?.version ?? null;
        const retryVer = await this.store.set(key, cacheEntry, currentVer, this.cacheTtlSeconds);
        if (retryVer) this.#storeVersion.set(key, retryVer);
      }
    }
    return version;
  }

  async transact<T>(action: (txn: IStoreTransaction) => Promise<T>): Promise<T> {
    return this.coordinator.transact(action);
  }

  async invalidateCache(key: string): Promise<void> {
    const current = await this.store.get<CacheEntry<unknown>>(key).catch(() => null);
    if (current !== null) {
      const ver = await this.store.set(
        key,
        { data: null, cachedAt: 0, coordinatorVersion: null } as unknown as CacheEntry<unknown>,
        current.version,
      ).catch(() => null);
      if (ver) this.#storeVersion.set(key, ver);
    }
  }
}
