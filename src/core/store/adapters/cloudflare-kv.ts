/// <reference types="@cloudflare/workers-types" />

import type { IAtomicStore, IStoreTransaction } from '../interfaces.ts';
import type { VersionId } from '../../brand.ts';
import { generateVersionId } from '../../brand.ts';

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
  constructor(private readonly kv: KVNamespace) {}

  async get<T>(key: string): Promise<{ value: T; version: VersionId } | null> {
    const result = await this.kv.getWithMetadata<T>(key, 'json');
    if (result.value === null) return null;
    const version = (result.metadata as { v?: string } | null)?.v;
    if (!version) return null;
    return { value: result.value, version: version as VersionId };
  }

  async set<T>(key: string, value: T, expectedVersion: VersionId | null): Promise<VersionId | null> {
    const existing = await this.kv.getWithMetadata<unknown>(key, 'json');
    const currentVersion = (existing.metadata as { v?: string } | null)?.v;

    // expectedVersion === null means "key must not exist"
    if (expectedVersion === null && existing.value !== null) return null;
    // expectedVersion must match current
    if (expectedVersion !== null && currentVersion !== expectedVersion) return null;

    const newVersion = generateVersionId();
    await this.kv.put(key, JSON.stringify(value), { metadata: { v: newVersion } });

    return newVersion;
  }

  async transact<T>(action: (txn: IStoreTransaction) => Promise<T>): Promise<T> {
    const txn: IStoreTransaction = {
      get: async <V>(key: string) => {
        const result = await this.kv.getWithMetadata<V>(key, 'json');
        return result.value;
      },
      set: async <V>(key: string, value: V) => {
        const newVersion = generateVersionId();
        await this.kv.put(key, JSON.stringify(value), { metadata: { v: newVersion } });
      },
    };
    return await action(txn);
  }
}
