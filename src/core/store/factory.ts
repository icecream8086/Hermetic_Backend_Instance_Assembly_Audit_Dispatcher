import type { StorageConfig } from './config.ts';
import type { IAtomicStore, IQueryStore, IBlobStore, Stores } from './interfaces.ts';
import { generateVersionId } from '../brand.ts';
import type { VersionId } from '../brand.ts';

export function createStores(_config: StorageConfig): Stores {
  // TODO: instantiate concrete adapters based on config backends
  return {
    atomic: createStubAtomicStore(),
    query: createStubQueryStore(),
    blob: createStubBlobStore(),
  };
}

function createStubAtomicStore(): IAtomicStore {
  const store = new Map<string, { value: unknown; version: VersionId }>();

  return {
    async get<T>(key: string) {
      const entry = store.get(key);
      if (!entry) return null;
      return entry as { value: T; version: VersionId };
    },

    async set<T>(key: string, value: T, expectedVersion: VersionId | null) {
      const entry = store.get(key);
      if (expectedVersion === null && entry) return null;
      if (expectedVersion !== null && (!entry || entry.version !== expectedVersion)) return null;
      const version = generateVersionId();
      store.set(key, { value, version });
      return version;
    },

    async transact<T>(action: (txn: {
      get<T>(key: string): Promise<T | null>;
      set<T>(key: string, value: T): void;
    }) => Promise<T>) {
      const txn = {
        get: async <T>(key: string) => {
          const entry = store.get(key);
          return entry ? (entry.value as T) : null;
        },
        set: <T>(key: string, value: T) => {
          const version = generateVersionId();
          store.set(key, { value, version });
        },
      };
      return action(txn);
    },
  };
}

function createStubQueryStore(): IQueryStore {
  return {
    async execute() {
      throw new Error('QueryStore not configured');
    },
  };
}

function createStubBlobStore(): IBlobStore {
  return {
    async put() { /* noop */ },
    async get() { return null; },
    async delete() { /* noop */ },
  };
}
