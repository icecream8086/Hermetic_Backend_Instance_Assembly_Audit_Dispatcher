import type { VersionId } from '../../../src/core/brand.ts';

interface StoredEntry {
  value: unknown;
  version: number;
}

export class StubAtomicStore {
  #store = new Map<string, StoredEntry>();
  #nextVer = 1;

  async get<T>(key: string): Promise<{ value: T; version: VersionId } | null> {
    const entry = this.#store.get(key);
    if (!entry) return null;
    return { value: entry.value as T, version: String(entry.version) as VersionId };
  }

  async set<T>(key: string, value: T, expectedVersion: VersionId | null): Promise<VersionId | null> {
    const current = this.#store.get(key);
    if (expectedVersion === null) {
      if (current !== undefined) return null; // key exists
    } else {
      if (!current || String(current.version) !== expectedVersion) return null;
    }
    const newVer = this.#nextVer++;
    if (value === null) {
      this.#store.delete(key);
    } else {
      this.#store.set(key, { value, version: newVer });
    }
    return String(newVer) as VersionId;
  }

  // Test helper
  _dump(): string[] { return [...this.#store.keys()]; }
}
