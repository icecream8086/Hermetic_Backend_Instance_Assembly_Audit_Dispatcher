/**
 * Request-scoped atomic store cache.
 * Wraps IAtomicStore and caches get() results per-key within a single request.
 * Transparently eliminates duplicate reads without changing business logic.
 *
 * Use case: in authz middleware chain, the same user/perm/route-ACL key may be
 * read multiple times (auth middleware → PermissionChecker → RouteAclManager).
 * This wrapper serves the second+ read from an in-memory map.
 *
 * set() and transact() bypass cache (writes must go to the real store).
 * invalidateCache() clears the cached entry.
 */

import type { IAtomicStore, IStoreTransaction } from './interfaces.ts';
import type { VersionId } from '../brand.ts';

export class RequestCachedAtomicStore implements IAtomicStore {
  readonly #inner: IAtomicStore;
  readonly #cache = new Map<string, { value: unknown; version: VersionId } | null>();

  constructor(inner: IAtomicStore) {
    this.#inner = inner;
  }

  async get<T>(key: string): Promise<{ value: T; version: VersionId } | null> {
    const cached = this.#cache.get(key);
    if (cached !== undefined) return cached as { value: T; version: VersionId } | null;

    const result = await this.#inner.get<T>(key);
    this.#cache.set(key, result);
    return result;
  }

  async set<T>(key: string, value: T, expectedVersion: VersionId | null, ttlSeconds?: number): Promise<VersionId | null> {
    this.#cache.delete(key);
    return this.#inner.set(key, value, expectedVersion, ttlSeconds);
  }

  async transact<T>(action: (txn: IStoreTransaction) => Promise<T>): Promise<T> {
    const result = await this.#inner.transact(action);
    this.#cache.clear();
    return result;
  }

  invalidateCache(key: string): Promise<void> {
    this.#cache.delete(key);
    return this.#inner.invalidateCache?.(key) ?? Promise.resolve();
  }
}
