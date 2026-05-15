import { describe, it, expect } from 'vitest';
import { HashTable } from '../../../src/core/hash-table/table.ts';

// ─── Test helpers ───

class TestTable<K, V> extends HashTable<K, V> {
  inspectBuckets() { return this.buckets; }
  protected override _hash(key: K): number {
    return super._hash(key);
  }
}

interface Entity {
  readonly id: string;
  readonly name: string;
}

// ─── Construction & mutation ───

describe('HashTable (white-box)', () => {
  describe('constructor', () => {
    it('creates empty table with default capacity', () => {
      const table = new TestTable<string, number>();
      expect(table.size).toBe(0);
      expect(table.isEmpty).toBe(true);
      expect(table.capacity).toBe(16);
    });

    it('accepts custom initial capacity', () => {
      const table = new TestTable<string, number>({ initialCapacity: 64 });
      expect(table.capacity).toBe(64);
    });
  });

  describe('set / get', () => {
    it('stores and retrieves a value', () => {
      const table = new TestTable<string, number>();
      table.set('a', 1);
      expect(table.get('a')).toBe(1);
    });

    it('returns undefined for missing key', () => {
      const table = new TestTable<string, number>();
      expect(table.get('missing')).toBeUndefined();
    });

    it('overwrites existing value', () => {
      const table = new TestTable<string, number>();
      table.set('a', 1);
      table.set('a', 2);
      expect(table.get('a')).toBe(2);
      expect(table.size).toBe(1);
    });

    it('stores multiple keys independently', () => {
      const table = new TestTable<string, number>();
      table.set('a', 1);
      table.set('b', 2);
      table.set('c', 3);
      expect(table.get('a')).toBe(1);
      expect(table.get('b')).toBe(2);
      expect(table.get('c')).toBe(3);
      expect(table.size).toBe(3);
    });

    it('stores non-string keys (number, object)', () => {
      const table = new TestTable<number, string>();
      table.set(42, 'answer');
      expect(table.get(42)).toBe('answer');
    });

    it('stores object keys', () => {
      const table = new TestTable<Entity, number>();
      const e1: Entity = { id: 'a', name: 'alpha' };
      const e2: Entity = { id: 'b', name: 'beta' };
      table.set(e1, 1);
      table.set(e2, 2);
      // same-key-object check uses reference equality via String()
      expect(table.get(e1)).toBe(1);
      expect(table.get(e2)).toBe(2);
    });
  });

  describe('has', () => {
    it('returns true for existing key', () => {
      const table = new TestTable<string, number>();
      table.set('a', 1);
      expect(table.has('a')).toBe(true);
    });

    it('returns false for missing key', () => {
      const table = new TestTable<string, number>();
      expect(table.has('a')).toBe(false);
    });
  });

  describe('delete', () => {
    it('removes a key and returns true', () => {
      const table = new TestTable<string, number>();
      table.set('a', 1);
      expect(table.delete('a')).toBe(true);
      expect(table.has('a')).toBe(false);
      expect(table.size).toBe(0);
    });

    it('returns false for missing key', () => {
      const table = new TestTable<string, number>();
      expect(table.delete('missing')).toBe(false);
    });

    it('does not affect other keys', () => {
      const table = new TestTable<string, number>();
      table.set('a', 1);
      table.set('b', 2);
      table.delete('a');
      expect(table.get('b')).toBe(2);
      expect(table.size).toBe(1);
    });
  });

  describe('clear', () => {
    it('removes all entries', () => {
      const table = new TestTable<string, number>();
      table.set('a', 1);
      table.set('b', 2);
      table.clear();
      expect(table.size).toBe(0);
      expect(table.isEmpty).toBe(true);
      expect(table.get('a')).toBeUndefined();
      expect(table.get('b')).toBeUndefined();
    });
  });

  describe('entries / keys / values', () => {
    it('entries returns all key-value pairs', () => {
      const table = new TestTable<string, number>();
      table.set('a', 1);
      table.set('b', 2);
      const entries = table.entries();
      expect(entries).toHaveLength(2);
      expect(entries).toContainEqual(['a', 1]);
      expect(entries).toContainEqual(['b', 2]);
    });

    it('keys returns all keys', () => {
      const table = new TestTable<string, number>();
      table.set('a', 1);
      table.set('b', 2);
      const keys = table.keys();
      expect(keys).toHaveLength(2);
      expect(keys).toContain('a');
      expect(keys).toContain('b');
    });

    it('values returns all values', () => {
      const table = new TestTable<string, number>();
      table.set('a', 1);
      table.set('b', 2);
      const values = table.values();
      expect(values).toHaveLength(2);
      expect(values).toContain(1);
      expect(values).toContain(2);
    });

    it('empty table returns empty arrays', () => {
      const table = new TestTable<string, number>();
      expect(table.entries()).toEqual([]);
      expect(table.keys()).toEqual([]);
      expect(table.values()).toEqual([]);
    });
  });

  describe('collision handling', () => {
    it('separate chaining handles hash collisions', () => {
      // Force collisions via trivial hash that maps all keys to the same bucket
      class AllCollide<K, V> extends TestTable<K, V> {
        protected override _hash(_key: K): number {
          return 0;
        }
      }
      const table = new AllCollide<number, string>();
      table.set(1, 'one');
      table.set(2, 'two');
      table.set(3, 'three');

      expect(table.size).toBe(3);
      expect(table.get(1)).toBe('one');
      expect(table.get(2)).toBe('two');
      expect(table.get(3)).toBe('three');

      // All entries end up in the same bucket
      const buckets = table.inspectBuckets();
      expect(buckets[0]!).toHaveLength(3);
    });

    it('collision bucket allows deletion', () => {
      const table = new TestTable<number, string>({ initialCapacity: 1, loadFactor: 1 });
      table.set(1, 'one');
      table.set(2, 'two');
      table.delete(1);
      expect(table.get(1)).toBeUndefined();
      expect(table.get(2)).toBe('two');
      expect(table.size).toBe(1);
    });
  });

  describe('resizing', () => {
    it('table grows when load factor exceeded', () => {
      const table = new TestTable<number, string>({
        initialCapacity: 4,
        loadFactor: 0.5,
      });
      // capacity=4, loadFactor=0.5 → resize when size > 2
      const initialCapacity = table.capacity;
      table.set(1, 'a');
      table.set(2, 'b');
      table.set(3, 'c'); // triggers resize
      expect(table.capacity).toBeGreaterThan(initialCapacity);
      expect(table.size).toBe(3);
      expect(table.get(1)).toBe('a');
      expect(table.get(2)).toBe('b');
      expect(table.get(3)).toBe('c');
    });

    it('all entries survive multiple resizes', () => {
      const table = new TestTable<number, number>({ initialCapacity: 4, loadFactor: 0.75 });
      for (let i = 0; i < 50; i++) {
        table.set(i, i * 10);
      }
      expect(table.size).toBe(50);
      expect(table.capacity).toBeGreaterThan(4);
      for (let i = 0; i < 50; i++) {
        expect(table.get(i)).toBe(i * 10);
      }
    });
  });

  describe('hash function override', () => {
    it('subclass can override _hash for custom strategy', () => {
      class EvenKeyTable<V> extends HashTable<number, V> {
        protected override _hash(key: number): number {
          // All even numbers collide, all odd numbers collide
          return key % 2;
        }
        exposeHash(key: number): number { return this._hash(key); }
      }

      const table = new EvenKeyTable<string>();
      table.set(1, 'odd');
      table.set(2, 'even');
      table.set(3, 'odd2');

      expect(table.get(1)).toBe('odd');
      expect(table.get(2)).toBe('even');
      expect(table.get(3)).toBe('odd2');
    });
  });

  // ─── Inheritance ───

  describe('inheritance', () => {
    it('subclass can add domain-specific methods', () => {
      class DefaultTable<V> extends HashTable<string, V> {
        getOrSet(key: string, defaultValue: V): V {
          if (this.has(key)) return this.get(key)!;
          this.set(key, defaultValue);
          return defaultValue;
        }
      }
      const table = new DefaultTable<number>();
      expect(table.getOrSet('a', 42)).toBe(42);
      expect(table.getOrSet('a', 99)).toBe(42); // already set
      expect(table.size).toBe(1);
    });

    it('subclass can override set with validation', () => {
      class NonEmptyTable extends HashTable<string, string> {
        override set(key: string, value: string): void {
          if (key.length === 0) throw new Error('Key must not be empty');
          if (value.length === 0) throw new Error('Value must not be empty');
          super.set(key, value);
        }
      }
      const table = new NonEmptyTable();
      expect(() => table.set('', 'val')).toThrow('Key must not be empty');
      expect(() => table.set('key', '')).toThrow('Value must not be empty');
      table.set('key', 'val');
      expect(table.get('key')).toBe('val');
    });
  });
});
