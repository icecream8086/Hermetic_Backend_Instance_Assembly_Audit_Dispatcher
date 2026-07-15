import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { IAtomicStore, IStoreTransaction } from '../interfaces.ts';
import { TransactConflictError } from '../interfaces.ts';
import { createVersionId, generateVersionId, type VersionId } from '../../brand.ts';

const { parse: parseJson } = JSON;

interface FileEntry<T = unknown> {
  value: T;
  metadata: { v: string; e?: number };
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

  public constructor(basePath: string) {
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

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- interface contract requires generics
  public async get<T>(key: string): Promise<{ value: T; version: VersionId } | null> {
    return this.#serialise(async () => {
      await this.#ensureDir();
      let result: { value: T; version: VersionId } | null = null;
      try {
        const raw = await readFile(this.#filePath(key), 'utf-8');
        const entry = z.custom<FileEntry<T>>().parse(parseJson(raw));
        if (entry.metadata.e && Date.now() > entry.metadata.e) {
          // TTL expired — delete file and return null
          try { await rm(this.#filePath(key), { force: true }); } catch (_e) {
            console.debug("file may not exist", _e);
          }
          return null;
        }
        // null value = deleted — consistent with DO adapter behavior
        if (entry.value === null) return null;
        result = { value: entry.value, version: createVersionId(entry.metadata.v) };
      } catch (_e) {
        console.debug("file read error", _e);
      }
      return result;
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- interface contract requires generics
  public async set<T>(key: string, value: T, expectedVersion: VersionId | null, ttlSeconds?: number): Promise<VersionId | null> {
    return this.#serialise(async () => {
      await this.#ensureDir();
      const fp = this.#filePath(key);

      let current: FileEntry | null = null;
      try {
        current = z.custom<FileEntry | null>().parse(parseJson(await readFile(fp, 'utf-8')));
      } catch (_e) {
        console.debug("no existing entry", _e);
      }
      if (expectedVersion === null && current !== null) return null;
      if (expectedVersion !== null && current?.metadata.v !== expectedVersion) return null;

      const newVersion = generateVersionId();
      const metadata: { v: string; e?: number } = { v: newVersion };
      if (ttlSeconds !== undefined) metadata.e = Date.now() + ttlSeconds * 1000;
      const entry: FileEntry = { value, metadata };
      await writeFile(fp, JSON.stringify(entry), 'utf-8');
      return newVersion;
    });
  }

  public async transact<T>(action: (txn: IStoreTransaction) => Promise<T>): Promise<T> {
    return this.#serialise(async () => {
      await this.#ensureDir();
      const readSet = new Map<string, string | null>(); // null = key didn't exist
      const deferredWrites = new Map<string, { value: unknown; version: VersionId; ttlSeconds?: number }>();

      const txn: IStoreTransaction = {
        get: async <V>(key: string) => {
          const dw = deferredWrites.get(key);
          if (dw !== undefined) return z.custom<V>().parse(dw.value);

          let fileValue: V | null = null;
          try {
            const raw = await readFile(this.#filePath(key), 'utf-8');
            const entry = z.custom<FileEntry<V>>().parse(parseJson(raw));
            readSet.set(key, entry.metadata.v);
            fileValue = entry.value;
          } catch (_e) {
            console.debug("file read error", _e);
            readSet.set(key, null);
          }
          return fileValue;
        },
        getMany: async <V>(keys: string[]) => {
          const results: (V | null)[] = [];
          for (const key of keys) {
            const dw = deferredWrites.get(key);
            if (dw !== undefined) {
              results.push(z.custom<V>().parse(dw.value));
              continue;
            }
            let fileValue: V | null = null;
            try {
              const raw = await readFile(this.#filePath(key), 'utf-8');
              const entry = z.custom<FileEntry<V>>().parse(parseJson(raw));
              readSet.set(key, entry.metadata.v);
              fileValue = entry.value;
            } catch (_e) {
              console.debug("file read error", _e);
              readSet.set(key, null);
            }
            results.push(fileValue);
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

      // Verify read-set versions haven't changed (excluding own writes)
      for (const [key, expectedVersion] of readSet) {
        if (deferredWrites.has(key)) continue;

        let currentVersion: string | null;
        try {
          const raw = await readFile(this.#filePath(key), 'utf-8');
          const entry = z.custom<FileEntry>().parse(parseJson(raw));
          currentVersion = entry.metadata.v;
        } catch (_e) {
          console.debug("file read error", _e);
          currentVersion = null;
        }
        if (currentVersion !== expectedVersion) {
          throw new TransactConflictError(
            `Transaction conflict: key "${key}" was modified concurrently.`,
          );
        }
      }

      for (const [key, { value, version, ttlSeconds }] of deferredWrites) {
        const metadata: { v: string; e?: number } = { v: version };
        if (ttlSeconds !== undefined) metadata.e = Date.now() + ttlSeconds * 1000;
        const entry: FileEntry = { value, metadata };
        await writeFile(this.#filePath(key), JSON.stringify(entry), 'utf-8');
      }

      return result;
    });
  }
}
