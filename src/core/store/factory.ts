/// <reference types="@cloudflare/workers-types" />

import type { StorageConfig } from './config.ts';
import type { IAtomicStore, IQueryStore, IBlobStore, Stores } from './interfaces.ts';

// Cloudflare adapters
import { CloudflareKVAtomicStore } from './adapters/cloudflare-kv.ts';
import { DurableObjectAtomicStore } from './adapters/durable-object.ts';
import { CachedAtomicStore } from './adapters/cached.ts';
import { D1QueryStore } from './adapters/d1.ts';
import { R2BlobStore } from './adapters/r2.ts';

// Metrics abstraction
import { AtomicStoreMetrics } from './metrics.ts';

export async function createStores(config: StorageConfig, platformBindings?: Record<string, unknown>): Promise<Stores> {
  const filePath = config.connections.filePath ?? '.data';
  const metrics = new AtomicStoreMetrics();

  return {
    atomic: await createAtomicStore(config, platformBindings, filePath, metrics),
    query: await createQueryStore(config, platformBindings, filePath),
    blob: await createBlobStore(config, platformBindings, filePath),
    metrics,
  };
}

// ══════════════════════════════════════════════
// Atomic store
// ══════════════════════════════════════════════

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- interface contract requires generics
function resolveBinding<T>(name: string, bindings?: Record<string, unknown>): T | undefined {
  return bindings?.[name] as T | undefined;
}

async function createAtomicStore(
  config: StorageConfig,
  bindings?: Record<string, unknown>,
  filePath?: string,
  metrics?: AtomicStoreMetrics,
): Promise<IAtomicStore> {
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

  const { FileKVAtomicStore } = await import('./adapters/file-kv.ts');
  return new FileKVAtomicStore(filePath ?? '.data/kv');
}

// ══════════════════════════════════════════════
// Query store (D1 > file > none)
// ══════════════════════════════════════════════

async function createQueryStore(
  config: StorageConfig,
  bindings?: Record<string, unknown>,
  filePath?: string,
): Promise<IQueryStore> {
  const d1Name = config.connections.d1Binding ?? 'QUERY_DB';
  const db = resolveBinding<D1Database>(d1Name, bindings);
  if (db) return new D1QueryStore(db);

  if (config.queryBackend === 'file' || config.queryBackend === 'd1') {
    const { FileQueryStore } = await import('./adapters/file-query.ts');
    return new FileQueryStore(filePath ?? '.data');
  }

  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- interface contract requires Promise<T>
    async execute() {
      throw new Error('QueryStore not configured. Set queryBackend or bind a D1 database.');
    },
  };
}

// ══════════════════════════════════════════════
// Blob store (R2 > file > none)
// ══════════════════════════════════════════════

async function createBlobStore(
  config: StorageConfig,
  bindings?: Record<string, unknown>,
  filePath?: string,
): Promise<IBlobStore> {
  const r2Name = config.connections.r2Binding ?? 'BLOB_STORE';
  const bucket = resolveBinding<R2Bucket>(r2Name, bindings);
  if (bucket) return new R2BlobStore(bucket);

  if (config.blobBackend === 'file' || config.blobBackend === 'r2') {
    const { FileBlobStore } = await import('./adapters/file-blob.ts');
    return new FileBlobStore(filePath ?? '.data');
  }

  return {
     
    async put() { /* noop */ },
    // eslint-disable-next-line @typescript-eslint/require-await -- interface contract requires Promise<T>
    async get() { return null; },
     
    async delete() { /* noop */ },
  };
}
