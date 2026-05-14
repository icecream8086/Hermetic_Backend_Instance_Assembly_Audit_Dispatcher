/// <reference types="@cloudflare/workers-types" />

import type { StorageConfig } from './config.ts';
import type { IAtomicStore, IQueryStore, IBlobStore, Stores } from './interfaces.ts';

// Cloudflare adapters
import { CloudflareKVAtomicStore } from './adapters/cloudflare-kv.ts';
import { DurableObjectAtomicStore } from './adapters/durable-object.ts';
import { D1QueryStore } from './adapters/d1.ts';
import { R2BlobStore } from './adapters/r2.ts';

// Local dev adapters
import { FileKVAtomicStore } from './adapters/file-kv.ts';
import { FileQueryStore } from './adapters/file-query.ts';
import { FileBlobStore } from './adapters/file-blob.ts';

export function createStores(config: StorageConfig, platformBindings?: Record<string, unknown>): Stores {
  const filePath = config.connections.filePath ?? '.data';

  return {
    atomic: createAtomicStore(config, platformBindings, filePath),
    query: createQueryStore(config, platformBindings, filePath),
    blob: createBlobStore(config, platformBindings, filePath),
  };
}

// ══════════════════════════════════════════
// Atomic store (DO > KV > file)
// ══════════════════════════════════════════

function createAtomicStore(
  config: StorageConfig,
  bindings?: Record<string, unknown>,
  filePath?: string,
): IAtomicStore {
  // 1. Check for Durable Object binding
  const doNsName = config.connections.doNamespace ?? 'ATOMIC_STORE_DO';
  const doNs = bindings?.[doNsName] as DurableObjectNamespace | undefined;
  if (doNs) {
    return new DurableObjectAtomicStore(doNs, config.connections.doInstanceName ?? 'global-store');
  }

  // 2. Check for KV binding
  const kvNsName = config.connections.kvNamespace ?? 'KV_STORE';
  const kvNs = bindings?.[kvNsName] as KVNamespace | undefined;
  if (kvNs) {
    return new CloudflareKVAtomicStore(kvNs);
  }

  // 3. Fall back to local file
  return new FileKVAtomicStore(filePath ?? '.data/kv');
}

// ══════════════════════════════════════════
// Query store (D1 > file > none)
// ══════════════════════════════════════════

function createQueryStore(
  config: StorageConfig,
  bindings?: Record<string, unknown>,
  filePath?: string,
): IQueryStore {
  // 1. Check for D1 binding
  const d1Name = config.connections.d1Binding ?? 'QUERY_DB';
  const db = bindings?.[d1Name] as D1Database | undefined;
  if (db) {
    return new D1QueryStore(db);
  }

  // 2. Fall back to local file query store
  if (config.queryBackend === 'file' || config.queryBackend === 'd1') {
    return new FileQueryStore(filePath ?? '.data');
  }

  // 3. No query store configured
  return {
    async execute() {
      throw new Error('QueryStore not configured. Set queryBackend or bind a D1 database.');
    },
  };
}

// ══════════════════════════════════════════
// Blob store (R2 > file > none)
// ══════════════════════════════════════════

function createBlobStore(
  config: StorageConfig,
  bindings?: Record<string, unknown>,
  filePath?: string,
): IBlobStore {
  // 1. Check for R2 binding
  const r2Name = config.connections.r2Binding ?? 'BLOB_STORE';
  const bucket = bindings?.[r2Name] as R2Bucket | undefined;
  if (bucket) {
    return new R2BlobStore(bucket);
  }

  // 2. Fall back to local file blob store
  if (config.blobBackend === 'file' || config.blobBackend === 'r2') {
    return new FileBlobStore(filePath ?? '.data');
  }

  // 3. No blob store configured
  return {
    async put() { /* noop */ },
    async get() { return null; },
    async delete() { /* noop */ },
  };
}
