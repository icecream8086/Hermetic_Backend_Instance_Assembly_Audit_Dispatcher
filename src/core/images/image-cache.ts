/**
 * Image cache LRU eviction — GitHub Cache model.
 *
 * Per-repo cap (maxTotalBytes) + LRU eviction + 7-day TTL on unaccessed images.
 * Mirrors GitHub Actions cache: 10GB repo cap, LRU eviction, 7-day stale cleanup.
 *
 * Registry credentials: delegates to ContainerSecret (Phase 5.2) for
 * registry auth — no separate credential store needed.
 */

import type { IAtomicStore } from '../store/interfaces.ts';

const CACHE_ENTRY_PREFIX = 'imgcache:';
const CACHE_INDEX_KEY = 'imgcache:ids';
const CACHE_TOTAL_SIZE_KEY = 'imgcache:totalSize';

// Defaults (GitHub Cache model: 10GB cap, 7-day stale)
const DEFAULT_MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
const DEFAULT_MAX_AGE_MS = 7 * 24 * 3_600_000; // 7 days

export interface ImageCacheEntry {
  imageId: string; // provider image ID (sha256:...)
  tags: string[];
  sizeBytes: number;
  pullCount: number;
  lastAccessedAt: number;
  createdAt: number;
}

export interface ImageCacheConfig {
  maxTotalBytes: number;
  maxAgeMs: number;
}

export const DEFAULT_IMAGE_CACHE_CONFIG: ImageCacheConfig = {
  maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
  maxAgeMs: DEFAULT_MAX_AGE_MS,
};

export interface EvictionResult {
  evicted: string[];
  reclaimedBytes: number;
}

export class ImageCacheTracker {
  public constructor(
    private readonly atomic: IAtomicStore,
    private readonly config: ImageCacheConfig = DEFAULT_IMAGE_CACHE_CONFIG,
  ) {}

  #key(imageId: string): string { return CACHE_ENTRY_PREFIX + imageId; }

  /** Record an image pull or access. Creates or updates the cache entry. */
  public async recordAccess(imageId: string, tags: string[], sizeBytes: number): Promise<void> {
    const now = Date.now();
    const existing = await this.atomic.get<ImageCacheEntry>(this.#key(imageId));

    if (existing) {
      const entry = existing.value;
      const sizeDelta = sizeBytes - entry.sizeBytes;
      await this.atomic.transact(async (txn) => {
        txn.set(this.#key(imageId), {
          ...entry,
          tags: [...new Set([...entry.tags, ...tags])],
          sizeBytes,
          pullCount: entry.pullCount + 1,
          lastAccessedAt: now,
        });
      });
      if (sizeDelta !== 0) {
        await this.#addToTotalSize(sizeDelta);
      }
    } else {
      const entry: ImageCacheEntry = {
        imageId, tags, sizeBytes,
        pullCount: 1,
        lastAccessedAt: now,
        createdAt: now,
      };
      await this.atomic.set(this.#key(imageId), entry, null);
      await this.#addToIndex(imageId);
      await this.#addToTotalSize(sizeBytes);
    }
  }

  /** Record an image removal. Removes the cache entry. */
  public async recordRemoval(imageId: string): Promise<void> {
    const existing = await this.atomic.get<ImageCacheEntry>(this.#key(imageId));
    if (!existing) return;
    await this.atomic.transact(async (txn) => {
      await this.#addToTotalSize(-existing.value.sizeBytes);
      txn.set(this.#key(imageId), null);
    });
    await this.#removeFromIndex(imageId);
  }

  /** Touch access time without changing other fields. */
  public async touch(imageId: string): Promise<void> {
    await this.atomic.transact(async (txn) => {
      const existing = await txn.get<ImageCacheEntry>(this.#key(imageId));
      if (!existing) return;
      txn.set(this.#key(imageId), { ...existing, lastAccessedAt: Date.now() });
    });
  }

  /** Get the current total cached size in bytes. */
  public async totalSize(): Promise<number> {
    const entry = await this.atomic.get<number>(CACHE_TOTAL_SIZE_KEY);
    return entry?.value ?? 0;
  }

  /** List all cache entries sorted by lastAccessedAt (oldest first). */
  public async listByLastAccess(): Promise<ImageCacheEntry[]> {
    const idx = await this.atomic.get<string[]>(CACHE_INDEX_KEY);
    if (!idx) return [];
    const entries = await Promise.all(
      idx.value.map(id => this.atomic.get<ImageCacheEntry>(CACHE_ENTRY_PREFIX + id)),
    );
    return entries
      .filter(e => e)
      .map(e => e!.value)
      .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
  }

  /**
   * Evict images to stay under the total byte limit (LRU) and remove stale entries.
   * Returns the list of evicted image IDs and total bytes reclaimed.
   * Does NOT perform the actual image removal — caller must call provider.remove().
   */
  public async computeEvictions(): Promise<EvictionResult> {
    const now = Date.now();
    const staleThreshold = now - this.config.maxAgeMs;
    const entries = await this.listByLastAccess();
    let currentTotal = await this.totalSize();

    const evicted: string[] = [];
    let reclaimedBytes = 0;

    for (const entry of entries) {
      // Evict if stale (7 days unaccessed) or over capacity
      const isStale = entry.lastAccessedAt < staleThreshold;
      const overCapacity = currentTotal > this.config.maxTotalBytes;

      if (isStale || overCapacity) {
        evicted.push(entry.imageId);
        reclaimedBytes += entry.sizeBytes;
        currentTotal -= entry.sizeBytes;
      }
    }

    return { evicted, reclaimedBytes };
  }

  /** Get a single cache entry. */
  public async get(imageId: string): Promise<ImageCacheEntry | null> {
    const entry = await this.atomic.get<ImageCacheEntry>(this.#key(imageId));
    return entry?.value ?? null;
  }

  // ─── Index helpers ───

  async #addToIndex(id: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const idx = await this.atomic.get<string[]>(CACHE_INDEX_KEY);
      const ok = await this.atomic.set(CACHE_INDEX_KEY, [...(idx?.value ?? []), id], idx?.version ?? null);
      if (ok) return;
    }
  }

  async #removeFromIndex(id: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const idx = await this.atomic.get<string[]>(CACHE_INDEX_KEY);
      if (!idx) return;
      const ok = await this.atomic.set(CACHE_INDEX_KEY, idx.value.filter(i => i !== id), idx.version);
      if (ok) return;
    }
  }

  async #addToTotalSize(delta: number): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const entry = await this.atomic.get<number>(CACHE_TOTAL_SIZE_KEY);
      const cur = entry?.value ?? 0;
      const next = Math.max(0, cur + delta);
      const ver = await this.atomic.set(CACHE_TOTAL_SIZE_KEY, next, entry?.version ?? null);
      if (ver) return;
    }
  }
}
