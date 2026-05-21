/// <reference types="@cloudflare/workers-types" />

import type { StorageConfig } from './config.ts';
import type { IAtomicStore, IQueryStore, IBlobStore, Stores } from './interfaces.ts';

// Cloudflare adapters
import { CloudflareKVAtomicStore } from './adapters/cloudflare-kv.ts';
import { DurableObjectAtomicStore } from './adapters/durable-object.ts';
import { CachedAtomicStore } from './adapters/cached.ts';
import { D1QueryStore } from './adapters/d1.ts';
import { R2BlobStore } from './adapters/r2.ts';

// Local dev adapters
import { FileKVAtomicStore } from './adapters/file-kv.ts';
import { FileQueryStore } from './adapters/file-query.ts';
import { FileBlobStore } from './adapters/file-blob.ts';

// Metrics abstraction
import { AtomicStoreMetrics } from './metrics.ts';

export function createStores(config: StorageConfig, platformBindings?: Record<string, unknown>): Stores {
  const filePath = config.connections.filePath ?? '.data';
  const metrics = new AtomicStoreMetrics();

  return {
    atomic: createAtomicStore(config, platformBindings, filePath, metrics),
    query: createQueryStore(config, platformBindings, filePath),
    blob: createBlobStore(config, platformBindings, filePath),
    metrics,
  };
}

// ══════════════════════════════════════════════
// Atomic store
// ══════════════════════════════════════════════

function resolveBinding<T>(name: string, bindings?: Record<string, unknown>): T | undefined {
  return bindings?.[name] as T | undefined;
}

function createAtomicStore(
  config: StorageConfig,
  bindings?: Record<string, unknown>,
  filePath?: string,
  metrics?: AtomicStoreMetrics,
): IAtomicStore {
  const doNsName = config.connections.doNamespace ?? 'ATOMIC_STORE_DO';
  const kvNsName = config.connections.kvNamespace ?? 'KV_STORE';

  const doNs = resolveBinding<DurableObjectNamespace>(doNsName, bindings);
  const kvNs = resolveBinding<KVNamespace>(kvNsName, bindings);

  const doStore = doNs
    ? new DurableObjectAtomicStore(doNs)
    : null;
  const kvStore = kvNs ? new CloudflareKVAtomicStore(kvNs) : null;

  if (doStore && kvStore) {
    return new CachedAtomicStore(doStore, kvStore, 30_000, config.cacheTtlSeconds, metrics);
  }
  if (doStore) return doStore;
  if (kvStore) return kvStore;

  return new FileKVAtomicStore(filePath ?? '.data/kv');
}

// ══════════════════════════════════════════════
// Query store (D1 > file > none)
// ══════════════════════════════════════════════

function createQueryStore(
  config: StorageConfig,
  bindings?: Record<string, unknown>,
  filePath?: string,
): IQueryStore {
  const d1Name = config.connections.d1Binding ?? 'QUERY_DB';
  const db = resolveBinding<D1Database>(d1Name, bindings);
  if (db) return new D1QueryStore(db);

  if (config.queryBackend === 'file' || config.queryBackend === 'd1') {
    return new FileQueryStore(filePath ?? '.data');
  }

  return {
    async execute() {
      throw new Error('QueryStore not configured. Set queryBackend or bind a D1 database.');
    },
  };
}

// ══════════════════════════════════════════════
// Blob store (R2 > file > none)
// ══════════════════════════════════════════════

function createBlobStore(
  config: StorageConfig,
  bindings?: Record<string, unknown>,
  filePath?: string,
): IBlobStore {
  const r2Name = config.connections.r2Binding ?? 'BLOB_STORE';
  const bucket = resolveBinding<R2Bucket>(r2Name, bindings);
  if (bucket) return new R2BlobStore(bucket);

  if (config.blobBackend === 'file' || config.blobBackend === 'r2') {
    return new FileBlobStore(filePath ?? '.data');
  }

  return {
    async put() { /* noop */ },
    async get() { return null; },
    async delete() { /* noop */ },
  };
}
