import type { HashTableOptions } from './interfaces.ts';

const DEFAULT_CAPACITY = 16;
const DEFAULT_LOAD_FACTOR = 0.75;

/** Internal bucket entry for separate chaining. */
interface BucketEntry<K, V> {
  key: K;
  value: V;
}

/**
 * Generic hash table base class with separate-chaining collision resolution.
 *
 * Automatically resizes when the load factor is exceeded. The hash function
 * is based on `String(key)`. Subclasses can override `_hash` to provide a
 * custom hash strategy.
 *
 * @example
 * ```ts
 * class CaseInsensitiveMap extends HashTable<string, number> {
 *   protected _hash(key: string): number {
 *     return super._hash(key.toLowerCase());
 *   }
 * }
 * ```
 */
export class HashTable<K, V> {
  protected buckets: BucketEntry<K, V>[][];
  protected _size = 0;
  protected readonly _initialCapacity: number;
  protected readonly _loadFactor: number;

  public constructor(options?: HashTableOptions) {
    this._initialCapacity = options?.initialCapacity ?? DEFAULT_CAPACITY;
    this._loadFactor = options?.loadFactor ?? DEFAULT_LOAD_FACTOR;
    this.buckets = Array.from({ length: this._initialCapacity }, () => []);
  }

  // ─── Mutation ───

  /** Insert or update a key-value pair. */
  public set(key: K, value: V): void {
    const bucket = this.#bucket(key);
    const existing = bucket.find(e => e.key === key);
    if (existing) {
      existing.value = value;
    } else {
      bucket.push({ key, value });
      this._size++;
      if (this._size > this.buckets.length * this._loadFactor) {
        this.#resize();
      }
    }
  }

  /** Remove a key. Returns true if the key existed. */
  public delete(key: K): boolean {
    const bucket = this.#bucket(key);
    const idx = bucket.findIndex(e => e.key === key);
    if (idx === -1) return false;
    bucket.splice(idx, 1);
    this._size--;
    return true;
  }

  /** Remove all entries. */
  public clear(): void {
    for (const bucket of this.buckets) {
      bucket.length = 0;
    }
    this._size = 0;
  }

  // ─── Queries ───

  /** Get the value for a key, or undefined if not found. */
  public get(key: K): V | undefined {
    return this.#bucket(key).find(e => e.key === key)?.value;
  }

  /** Check if a key exists in the table. */
  public has(key: K): boolean {
    return this.#bucket(key).some(e => e.key === key);
  }

  /** Return all entries as an array of [key, value] pairs. */
  public entries(): [K, V][] {
    const result: [K, V][] = [];
    for (const bucket of this.buckets) {
      for (const entry of bucket) {
        result.push([entry.key, entry.value]);
      }
    }
    return result;
  }

  /** Return all keys. */
  public keys(): K[] {
    const result: K[] = [];
    for (const bucket of this.buckets) {
      for (const entry of bucket) {
        result.push(entry.key);
      }
    }
    return result;
  }

  /** Return all values. */
  public values(): V[] {
    const result: V[] = [];
    for (const bucket of this.buckets) {
      for (const entry of bucket) {
        result.push(entry.value);
      }
    }
    return result;
  }

  // ─── Properties ───

  public get size(): number {
    return this._size;
  }

  public get isEmpty(): boolean {
    return this._size === 0;
  }

  /** Current number of buckets (capacity). */
  public get capacity(): number {
    return this.buckets.length;
  }

  // ─── Hooks for subclasses ───

  /**
   * Hash function. Uses DJB2 on the stringified key.
   * Override to provide a custom hash strategy.
   */
  protected _hash(key: K): number {
    const str = String(key);
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) + hash + str.charCodeAt(i);
      hash = hash & hash; // force 32-bit integer
    }
    return Math.abs(hash);
  }

  // ─── Internal ───

  #bucket(key: K): BucketEntry<K, V>[] {
    const index = this._hash(key) % this.buckets.length;
    return this.buckets[index]!;
  }

  #resize(): void {
    const oldBuckets = this.buckets;
    const newCapacity = this.buckets.length * 2;
    this.buckets = Array.from({ length: newCapacity }, () => []);
    this._size = 0;

    for (const bucket of oldBuckets) {
      for (const entry of bucket) {
        this.set(entry.key, entry.value);
      }
    }
  }
}
