import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { IAtomicStore, IStoreTransaction } from '../interfaces.ts';
import { TransactConflictError } from '../interfaces.ts';
import type { VersionId } from '../../brand.ts';
import { generateVersionId } from '../../brand.ts';

interface FileEntry<T = unknown> {
  value: T;
  metadata: { v: string };
}

/**
 * Local file-based adapter for Node.js development.
 * Each key is a JSON file in `dataDir`.
 * Restart-safe — data survives across process restarts.
 *
 * Concurrency: all operations serialised via a global promise chain so
 * that read-compare-write sequences are safe from races within the same
 * process. Cross-process safety is NOT provided (adapter is for dev only).
 */
export class FileKVAtomicStore implements IAtomicStore {
  #dataDir: string;
  #lock: Promise<void> = Promise.resolve();

  constructor(basePath: string) {
    this.#dataDir = resolve(basePath);
  }

  #serialise<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.#lock;
    let release!: () => void;
    this.#lock = new Promise(resolve => { release = resolve; });
    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        release();
      }
    });
  }

  async #ensureDir(): Promise<void> {
    await mkdir(this.#dataDir, { recursive: true });
  }

  #filePath(key: string): string {
    const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(this.#dataDir, `${safe}.json`);
  }

  async get<T>(key: string): Promise<{ value: T; version: VersionId } | null> {
    return this.#serialise(async () => {
      await this.#ensureDir();
      try {
        const raw = await readFile(this.#filePath(key), 'utf-8');
        const entry = JSON.parse(raw) as FileEntry<T>;
        return { value: entry.value, version: entry.metadata.v as VersionId };
      } catch {
        return null;
      }
    });
  }

  async set<T>(key: string, value: T, expectedVersion: VersionId | null): Promise<VersionId | null> {
    return this.#serialise(async () => {
      await this.#ensureDir();
      const fp = this.#filePath(key);

      let current: FileEntry | null = null;
      try {
        current = JSON.parse(await readFile(fp, 'utf-8')) as FileEntry;
      } catch {
        // file doesn't exist
      }

      if (expectedVersion === null && current !== null) return null;
      if (expectedVersion !== null && current?.metadata.v !== expectedVersion) return null;

      const newVersion = generateVersionId();
      const entry: FileEntry = { value, metadata: { v: newVersion } };
      await writeFile(fp, JSON.stringify(entry), 'utf-8');
      return newVersion;
    });
  }

  async transact<T>(action: (txn: IStoreTransaction) => Promise<T>): Promise<T> {
    return this.#serialise(async () => {
      await this.#ensureDir();
      const readSet = new Map<string, string | null>(); // null = key didn't exist
      const deferredWrites = new Map<string, { value: unknown; version: VersionId }>();

      const txn: IStoreTransaction = {
        get: async <V>(key: string) => {
          // Read-your-own-writes: check deferred writes first
          const dw = deferredWrites.get(key);
          if (dw !== undefined) return dw.value as V;

          try {
            const raw = await readFile(this.#filePath(key), 'utf-8');
            const entry = JSON.parse(raw) as FileEntry<V>;
            readSet.set(key, entry.metadata.v);
            return entry.value;
          } catch {
            readSet.set(key, null); // track "key didn't exist" dependency
            return null;
          }
        },
        set: async <V>(key: string, value: V) => {
          const newVersion = generateVersionId();
          deferredWrites.set(key, { value, version: newVersion });
        },
      };

      const result = await action(txn);

      // Verify read-set versions haven't changed (excluding own writes)
      for (const [key, expectedVersion] of readSet) {
        if (deferredWrites.has(key)) continue;

        let currentVersion: string | null;
        try {
          const raw = await readFile(this.#filePath(key), 'utf-8');
          const entry = JSON.parse(raw) as FileEntry;
          currentVersion = entry.metadata.v;
        } catch {
          currentVersion = null;
        }

        if (currentVersion !== expectedVersion) {
          throw new TransactConflictError(
            `Transaction conflict: key "${key}" was modified concurrently.`,
          );
        }
      }

      // Apply all deferred writes — within #serialise this is atomic
      for (const [key, { value, version }] of deferredWrites) {
        const entry: FileEntry = { value, metadata: { v: version } };
        await writeFile(this.#filePath(key), JSON.stringify(entry), 'utf-8');
      }

      return result;
    });
  }
}
