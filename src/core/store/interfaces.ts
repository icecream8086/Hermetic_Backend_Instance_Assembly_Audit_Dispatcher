import type { VersionId } from '../brand.ts';

/**
 * Transaction-scoped read/write operations.
 * All operations within a transaction are serialized and atomic.
 */
export interface IStoreTransaction {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): void;
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
   */
  set<T>(key: string, value: T, expectedVersion: VersionId | null): Promise<VersionId | null>;

  /** Execute operations inside a serialized atomic transaction. */
  transact<T>(action: (txn: IStoreTransaction) => Promise<T>): Promise<T>;
}

/**
 * Cold query layer: relational queries and complex reporting.
 */
export interface IQueryStore {
  execute<T = unknown>(sql: string, params?: QueryParams): Promise<T[]>;
}

export type QueryParams = Record<string, unknown> | unknown[];

/**
 * Binary archive layer: large objects and log backups.
 */
export interface IBlobStore {
  put(key: string, body: ReadableStream | Buffer, metadata?: BlobMetadata): Promise<void>;
  get(key: string): Promise<ReadableStream | null>;
  delete(key: string): Promise<void>;
}

export interface BlobMetadata {
  contentType?: string;
  contentLength?: number;
  custom?: Record<string, string>;
}

/**
 * Aggregated stores for dependency injection.
 */
export interface Stores {
  readonly atomic: IAtomicStore;
  readonly query: IQueryStore;
  readonly blob: IBlobStore;
}
