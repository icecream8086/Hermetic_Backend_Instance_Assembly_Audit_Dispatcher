import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileKVAtomicStore } from '../../../../src/core/store/adapters/file-kv.ts';
import { TransactConflictError } from '../../../../src/core/store/interfaces.ts';

// ─── White-box: inspect the raw JSON files on disk ───

function readEntry(dataDir: string, key: string): { value: unknown; metadata: { v: string } } | null {
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_');
  const fp = join(dataDir, `${safe}.json`);
  if (!existsSync(fp)) return null;
  return JSON.parse(readFileSync(fp, 'utf-8'));
}

function writeEntry(dataDir: string, key: string, value: unknown, version: string): void {
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_');
  const fp = join(dataDir, `${safe}.json`);
  writeFileSync(fp, JSON.stringify({ value, metadata: { v: version } }), 'utf-8');
}

function listFiles(dataDir: string): string[] {
  if (!existsSync(dataDir)) return [];
  const { readdirSync } = require('node:fs');
  return readdirSync(dataDir);
}

describe('FileKVAtomicStore (white-box)', () => {
  let dataDir: string;
  let store: FileKVAtomicStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'file-kv-test-'));
    store = new FileKVAtomicStore(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  // ─── get / set ───

  describe('get / set', () => {
    it('get returns null for non-existent key', async () => {
      const result = await store.get('missing');
      expect(result).toBeNull();
    });

    it('set with expectedVersion=null creates a new entry', async () => {
      const version = await store.set('my-key', { hello: 'world' }, null);
      expect(version).toBeTruthy();
      expect(typeof version).toBe('string');

      // White-box: check the file on disk
      const entry = readEntry(dataDir, 'my-key');
      expect(entry).not.toBeNull();
      expect(entry!.value).toEqual({ hello: 'world' });
      expect(entry!.metadata.v).toBe(version);
    });

    it('set with expectedVersion=null rejects if key already exists', async () => {
      await store.set('key', 1, null);
      const version = await store.set('key', 2, null);
      expect(version).toBeNull();

      // White-box: value on disk should still be the first write
      const entry = readEntry(dataDir, 'key');
      expect(entry!.value).toBe(1);
    });

    it('set with matching expectedVersion succeeds (update)', async () => {
      const v1 = await store.set('key', 'first', null);
      const v2 = await store.set('key', 'second', v1);

      expect(v2).toBeTruthy();
      expect(v2).not.toBe(v1);

      const entry = readEntry(dataDir, 'key');
      expect(entry!.value).toBe('second');
      expect(entry!.metadata.v).toBe(v2);
    });

    it('set with mismatched expectedVersion fails (concurrent write)', async () => {
      await store.set('key', 'original', null);
      // stale version
      const version = await store.set('key', 'stale', 'wrong-version' as any);
      expect(version).toBeNull();

      // White-box: file unchanged
      const entry = readEntry(dataDir, 'key');
      expect(entry!.value).toBe('original');
    });

    it('get reads back what was written', async () => {
      await store.set('key', { a: [1, 2, 3] }, null);
      const result = await store.get<{ a: number[] }>('key');
      expect(result).not.toBeNull();
      expect(result!.value).toEqual({ a: [1, 2, 3] });
      expect(typeof result!.version).toBe('string');
    });

    it('version changes on each set', async () => {
      const v1 = await store.set('key', 1, null);
      const v2 = await store.set('key', 2, v1);
      const v3 = await store.set('key', 3, v2);

      expect(v1).not.toBe(v2);
      expect(v2).not.toBe(v3);
      expect(v1).not.toBe(v3);

      // White-box: file has the latest version
      const entry = readEntry(dataDir, 'key');
      expect(entry!.metadata.v).toBe(v3);
      expect(entry!.value).toBe(3);
    });

    it('stores and retrieves complex nested objects', async () => {
      const obj = { level1: { level2: [1, 'two', true] } };
      await store.set('complex', obj, null);
      const result = await store.get<typeof obj>('complex');
      expect(result!.value).toEqual(obj);
    });
  });

  // ─── Key sanitisation (white-box: file names) ───

  describe('key sanitisation (white-box: file names on disk)', () => {
    it('sanitises special characters in keys to underscores', async () => {
      await store.set('hello/world:test', 'value', null);
      const files = listFiles(dataDir);
      expect(files.some(f => f.includes('hello_world_test'))).toBe(true);
    });

    it('sanitises whitespace and dots', async () => {
      await store.set('key with spaces', 'val', null);
      const files = listFiles(dataDir);
      expect(files.some(f => f.includes('key_with_spaces'))).toBe(true);
    });

    it('alphanumeric keys pass through unchanged', async () => {
      await store.set('simple-key.v1_0', 'val', null);
      const files = listFiles(dataDir);
      expect(files.some(f => f.startsWith('simple-key.v1_0'))).toBe(true);
    });
  });

  // ─── transact ───

  describe('transact', () => {
    it('can read and write within a transaction', async () => {
      await store.set('a', 1, null);
      await store.set('b', 2, null);

      const result = await store.transact(async (txn) => {
        const va = await txn.get<number>('a');
        const vb = await txn.get<number>('b');
        await txn.set('sum', va! + vb!);
        return 'done';
      });

      expect(result).toBe('done');

      // White-box: verify files on disk
      const sumEntry = readEntry(dataDir, 'sum');
      expect(sumEntry!.value).toBe(3);
    });

    it('transaction get returns null for missing key', async () => {
      const val = await store.transact(async (txn) => {
        return txn.get<unknown>('nonexistent');
      });
      expect(val).toBeNull();
    });

    it('transaction writes are persisted to disk', async () => {
      await store.transact(async (txn) => {
        await txn.set('tx-key', { persisted: true });
      });

      const entry = readEntry(dataDir, 'tx-key');
      expect(entry!.value).toEqual({ persisted: true });
    });

    it('multiple transactional writes do not interfere', async () => {
      await store.transact(async (txn) => {
        await txn.set('x', 10);
        await txn.set('y', 20);
        await txn.set('z', 30);
      });

      expect(readEntry(dataDir, 'x')!.value).toBe(10);
      expect(readEntry(dataDir, 'y')!.value).toBe(20);
      expect(readEntry(dataDir, 'z')!.value).toBe(30);
    });

    it('detects concurrent file modification via TransactConflictError', async () => {
      await store.set('a', 'original', null);

      await expect(store.transact(async (txn) => {
        // Read key 'a' — records version in readSet
        const val = await txn.get<string>('a');
        expect(val).toBe('original');

        // Simulate concurrent write from another process to the SAME
        // key — directly modify the underlying file with a different version.
        writeEntry(dataDir, 'a', 'concurrent-write', 'other-version');

        // Write a DIFFERENT key 'b' (not in readSet), so the post-
        // callback check WILL verify 'a's version and detect the conflict.
        await txn.set('b', 'transaction-write');
        return 'done';
      })).rejects.toThrow(TransactConflictError);

      // The concurrent write should be preserved on disk
      const entryA = readEntry(dataDir, 'a');
      expect(entryA!.value).toBe('concurrent-write');
      expect(entryA!.metadata.v).toBe('other-version');
    });

    it('detects phantom read (null dependency tracking)', async () => {
      await expect(store.transact(async (txn) => {
        // Read non-existent key — records null dependency in readSet
        const val = await txn.get<string>('x');
        expect(val).toBeNull();

        // Simulate another process creating key 'x' via direct file write
        writeEntry(dataDir, 'x', 'created-concurrently', 'v1');

        // Write a different key — post-callback check will verify 'x'
        // expected null but found 'v1' → conflict
        await txn.set('y', 'based_on_x_absent');
        return 'done';
      })).rejects.toThrow(TransactConflictError);

      // The concurrent write is preserved
      const entryX = readEntry(dataDir, 'x');
      expect(entryX!.value).toBe('created-concurrently');
    });
  });

  // ─── Persistence across restarts (white-box: files survive) ───

  describe('persistence (files survive after store is discarded)', () => {
    it('data written to disk is readable by a new store instance', async () => {
      await store.set('persist-key', 'stored', null);

      // Create a new store pointing to the same directory
      const store2 = new FileKVAtomicStore(dataDir);
      const result = await store2.get<string>('persist-key');
      expect(result!.value).toBe('stored');
    });

    it('empty dataDir contains no files after creation', () => {
      const files = listFiles(dataDir);
      expect(files).toEqual([]);
    });
  });

  // ─── Edge cases ───

  describe('edge cases', () => {
    it('handles undefined and null values', async () => {
      // null is valid JSON
      await store.set('null-key', null, null);
      const result = await store.get<null>('null-key');
      // Since the JSON object stores { value: null }, the get method
      // would return { value: null, version: ... } — not null
      expect(result).not.toBeNull();
      expect(result!.value).toBeNull();
    });

    it('handles boolean values', async () => {
      await store.set('bool', true, null);
      const result = await store.get<boolean>('bool');
      expect(result!.value).toBe(true);
    });

    it('handles numeric zero', async () => {
      await store.set('zero', 0, null);
      const result = await store.get<number>('zero');
      expect(result!.value).toBe(0);
    });

    it('handles empty string key', async () => {
      await store.set('', 'empty-key', null);
      const result = await store.get<string>('');
      expect(result!.value).toBe('empty-key');
    });
  });
});
