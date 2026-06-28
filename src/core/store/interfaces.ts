import type { VersionId } from '../brand.ts';

/**
 * Transaction-scoped read/write operations.
 * All operations within a transaction are serialized and atomic.
 *
 * getMany 明确批量读，不受 queueMicrotask 时机影响。
 * 后端实现应尽量合并为一次 I/O。
 */
export interface IStoreTransaction {
  get<T>(key: string): Promise<T | null>;

  /** 批量读多个 key。后端保证在 DO 上合并为一次 batchGet。 */
  getMany<T>(keys: string[]): Promise<(T | null)[]>;

  set<T>(key: string, value: T, ttlSeconds?: number): void;
}

/**
 * transact 重试包装器，指数退避。
 *
 * 用法:
 *   const result = await withRetry(() => atomic.transact(fn));
 */
export class TransactRetryExhausted extends Error {
  public constructor(retries: number, cause?: unknown) {
    super(`Transaction failed after ${retries} retries`);
    this.name = 'TransactRetryExhausted';
    this.cause = cause;
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: { maxRetries?: number; baseDelayMs?: number },
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 50;
  let lastError: unknown;

  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof TransactConflictError)) throw e;
      if (i === maxRetries) throw new TransactRetryExhausted(maxRetries + 1, e);
      lastError = e;
      await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, i)));
    }
  }

  throw new TransactRetryExhausted(maxRetries + 1, lastError);
}

/**
 * Hot state layer: atomic operations with optimistic concurrency.
 */
export interface IAtomicStore {
  /** Read current value and its version. Returns null if key does not exist. */
  get<T>(key: string): Promise<{ value: T; version: VersionId } | null>;

  /**
   * Atomic write with version check.
   * Pass `expectedVersion = null` to assert the key does not yet exist (create-only).
   * Returns the new version on success, or null on conflict.
   * Pass `ttlSeconds` to set server-side TTL on backends that support it (e.g. KV).
   */
  set<T>(key: string, value: T, expectedVersion: VersionId | null, ttlSeconds?: number): Promise<VersionId | null>;

  /** Execute operations inside a serialized atomic transaction. */
  transact<T>(action: (txn: IStoreTransaction) => Promise<T>): Promise<T>;

  /**
   * Evict a key from the read-through cache so the next get() goes to
   * the authoritative coordinator (DO). No-op on backends without caching.
   */
  invalidateCache?(key: string): Promise<void>;
}

/**
 * Cold query layer: relational queries and complex reporting.
 */
export interface IQueryStore {
  execute<T = unknown>(sql: string, params?: QueryParams): Promise<T[]>;
}

export type QueryParams = Record<string, unknown> | unknown[];

/**
 * Error thrown when a transaction fails due to an optimistic concurrency conflict.
 * The caller should catch this and retry the transaction if appropriate.
 */
export class TransactConflictError extends Error {
  public constructor(message?: string) {
    super(message ?? 'Transaction conflict detected. One or more keys were modified concurrently.');
    this.name = 'TransactConflictError';
  }
}

/**
 * Binary archive layer: large objects and log backups.
 */
export interface IBlobStore {
  put(key: string, body: ReadableStream | ArrayBuffer, metadata?: BlobMetadata): Promise<void>;
  get(key: string): Promise<ReadableStream | null>;
  delete(key: string): Promise<void>;
}

export interface BlobMetadata {
  contentType?: string;
  contentLength?: number;
  custom?: Record<string, string>;
}

import type { IServerMetrics } from './metrics.ts';

/**
 * Aggregated stores for dependency injection.
 */
export interface Stores {
  readonly atomic: IAtomicStore;
  readonly query: IQueryStore;
  readonly blob: IBlobStore;
  /** 缓存命中率指标抽象层 — 底层可对接 Cloudflare 或其他平台 API. */
  readonly metrics: IServerMetrics;
}
