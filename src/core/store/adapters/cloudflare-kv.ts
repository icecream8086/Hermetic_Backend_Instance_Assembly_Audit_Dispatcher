/// <reference types="@cloudflare/workers-types" />

import type { IAtomicStore, IStoreTransaction } from '../interfaces.ts';
import { TransactConflictError } from '../interfaces.ts';
import type { VersionId } from '../../brand.ts';
import { generateVersionId, createVersionId } from '../../brand.ts';

interface KvMetadata { v?: string }

/**
 * Cloudflare Workers KV adapter for IAtomicStore.
 *
 * Version (optimistic lock) is stored as KV metadata.
 * This is NOT strictly atomic — there's a small race window between
 * getWithMetadata and put. For the sandbox provisioning use case
 * (low write contention), this is acceptable.
 *
 * For strong consistency, use Durable Objects instead.
 */
export class CloudflareKVAtomicStore implements IAtomicStore {
  public constructor(private readonly kv: KVNamespace) {}

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- interface contract requires generics
  public async get<T>(key: string): Promise<{ value: T; version: VersionId } | null> {
    const result = await this.kv.getWithMetadata<T>(key, 'json');
    if (result.value === null) return null;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Cloudflare KV metadata is untyped, schema validation at call site
    const version = (result.metadata as KvMetadata | null)?.v;
    if (!version) return null;
    return { value: result.value, version: createVersionId(version) };
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- interface contract requires generics
  public async set<T>(key: string, value: T, expectedVersion: VersionId | null, ttlSeconds?: number): Promise<VersionId | null> {
    const existing = await this.kv.getWithMetadata(key, 'json');
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Cloudflare KV metadata is untyped
    const currentVersion = (existing.metadata as KvMetadata | null)?.v;

    if (expectedVersion === null && existing.value !== null) return null;
    if (expectedVersion !== null && currentVersion !== expectedVersion) return null;

    const newVersion = generateVersionId();
    const options: KVNamespacePutOptions = { metadata: { v: newVersion } };
    if (ttlSeconds !== undefined) options.expirationTtl = ttlSeconds;
    await this.kv.put(key, JSON.stringify(value), options);

    return newVersion;
  }

  public async transact<T>(action: (txn: IStoreTransaction) => Promise<T>): Promise<T> {
    const readSet = new Map<string, string | null>();
    const deferredWrites = new Map<string, { value: unknown; version: VersionId; ttlSeconds?: number }>();

    const txn: IStoreTransaction = {
      get: async <V>(key: string) => {
        const dw = deferredWrites.get(key);
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- transaction deferred write, type guaranteed by set()
        if (dw !== undefined) return dw.value as V;

        const result = await this.kv.getWithMetadata<V>(key, 'json');
        const version = (result.metadata as KvMetadata | null)?.v ?? null;
        readSet.set(key, version);
        return result.value ?? null;
      },
      getMany: async <V>(keys: string[]) => {
        const results: (V | null)[] = [];
        for (const key of keys) {
          const dw = deferredWrites.get(key);
          if (dw !== undefined) {
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- transaction deferred write, type guaranteed by set()
            results.push(dw.value as V);
            continue;
          }
          const result = await this.kv.getWithMetadata<V>(key, 'json');
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Cloudflare KV metadata is untyped
          const version = (result.metadata as KvMetadata | null)?.v ?? null;
          readSet.set(key, version);
          results.push(result.value ?? null);
        }
        return results;
      },
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- interface contract requires generics
      set: <V>(key: string, value: V, ttlSeconds?: number) => {
        const newVersion = generateVersionId();
        deferredWrites.set(key, { value, version: newVersion, ...(ttlSeconds !== undefined && { ttlSeconds }) });
      },
    };

    const result = await action(txn);

    for (const [key, expectedVersion] of readSet) {
      if (deferredWrites.has(key)) continue;
      const current = await this.kv.getWithMetadata(key, 'json');
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Cloudflare KV metadata is untyped
      const currentVersion = (current.metadata as KvMetadata | null)?.v;
      if (currentVersion !== expectedVersion) {
        throw new TransactConflictError(
          `Transaction conflict: key "${key}" was modified concurrently.`,
        );
      }
    }

    for (const [key, { value, version, ttlSeconds }] of deferredWrites) {
      const options: KVNamespacePutOptions = { metadata: { v: version } };
      if (ttlSeconds !== undefined) options.expirationTtl = ttlSeconds;
      await this.kv.put(key, JSON.stringify(value), options);
    }

    return result;
  }
}
