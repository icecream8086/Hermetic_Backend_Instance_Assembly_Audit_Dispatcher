import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { IAtomicStore, IStoreTransaction } from '../interfaces.ts';
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
 */
export class FileKVAtomicStore implements IAtomicStore {
  #dataDir: string;

  constructor(basePath: string) {
    this.#dataDir = resolve(basePath);
  }

  async #ensureDir(): Promise<void> {
    await mkdir(this.#dataDir, { recursive: true });
  }

  #filePath(key: string): string {
    // Sanitize key to a safe filename
    const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(this.#dataDir, `${safe}.json`);
  }

  async get<T>(key: string): Promise<{ value: T; version: VersionId } | null> {
    await this.#ensureDir();
    try {
      const raw = await readFile(this.#filePath(key), 'utf-8');
      const entry = JSON.parse(raw) as FileEntry<T>;
      return { value: entry.value, version: entry.metadata.v as VersionId };
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, expectedVersion: VersionId | null): Promise<VersionId | null> {
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
  }

  async transact<T>(action: (txn: IStoreTransaction) => Promise<T>): Promise<T> {
    await this.#ensureDir();
    // Simple implementation: no rollback, just sequential writes
    const txn: IStoreTransaction = {
      get: async <V>(key: string) => {
        try {
          const raw = await readFile(this.#filePath(key), 'utf-8');
          return (JSON.parse(raw) as FileEntry<V>).value;
        } catch {
          return null;
        }
      },
      set: async <V>(key: string, value: V) => {
        const newVersion = generateVersionId();
        const entry: FileEntry = { value, metadata: { v: newVersion } };
        await writeFile(this.#filePath(key), JSON.stringify(entry), 'utf-8');
      },
    };
    return await action(txn);
  }
}
