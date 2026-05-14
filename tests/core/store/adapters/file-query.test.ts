import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileQueryStore } from '../../../../src/core/store/adapters/file-query.ts';

// ─── White-box helpers ───

function readTable(dataDir: string, tableName: string): Record<string, unknown>[] {
  const fp = join(dataDir, 'query', `${tableName}.json`);
  if (!existsSync(fp)) return [];
  return JSON.parse(readFileSync(fp, 'utf-8'));
}

function listTables(dataDir: string): string[] {
  const queryDir = join(dataDir, 'query');
  if (!existsSync(queryDir)) return [];
  return readdirSync(queryDir).filter(f => f.endsWith('.json'));
}

describe('FileQueryStore (white-box)', () => {
  let dataDir: string;
  let store: FileQueryStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'file-query-test-'));
    store = new FileQueryStore(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  // ─── SELECT * FROM ───

  describe('SELECT * FROM', () => {
    it('returns empty array for empty table', async () => {
      const rows = await store.execute('SELECT * FROM users');
      expect(rows).toEqual([]);
    });

    it('returns all rows after INSERT', async () => {
      await store.execute('INSERT INTO items VALUES (?, ?)', [1, 'a']);
      await store.execute('INSERT INTO items VALUES (?, ?)', [2, 'b']);

      const rows = await store.execute('SELECT * FROM items');
      expect(rows).toHaveLength(2);
    });

    it('white-box: SELECT reads from the correct JSON file', async () => {
      // Pre-populate the table file with known data
      const { mkdirSync, writeFileSync } = require('node:fs');
      const queryDir = join(dataDir, 'query');
      mkdirSync(queryDir, { recursive: true });
      writeFileSync(join(queryDir, 'teams.json'), JSON.stringify([
        { name: 'alpha', score: 10 },
        { name: 'beta', score: 20 },
      ]));

      const rows = await store.execute<{ name: string; score: number }>('SELECT * FROM teams');
      expect(rows).toHaveLength(2);
      expect(rows[0]!.name).toBe('alpha');
      expect(rows[1]!.score).toBe(20);
    });
  });

  // ─── SELECT * FROM ... WHERE col = ? ───

  describe('SELECT ... WHERE', () => {
    it('filters rows by parameterised WHERE clause', async () => {
      const { mkdirSync, writeFileSync } = require('node:fs');
      const queryDir = join(dataDir, 'query');
      mkdirSync(queryDir, { recursive: true });
      writeFileSync(join(queryDir, 'users.json'), JSON.stringify([
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
        { id: 3, name: 'Alice' },
      ]));

      const rows = await store.execute<{ id: number; name: string }>(
        'SELECT * FROM users WHERE name = ?',
        ['Alice'],
      );
      expect(rows).toHaveLength(2);
      expect(rows.every(r => r.name === 'Alice')).toBe(true);
    });

    it('WHERE with non-matching value returns empty', async () => {
      const { mkdirSync, writeFileSync } = require('node:fs');
      const queryDir = join(dataDir, 'query');
      mkdirSync(queryDir, { recursive: true });
      writeFileSync(join(queryDir, 'users.json'), JSON.stringify([
        { id: 1, name: 'Alice' },
      ]));

      const rows = await store.execute(
        'SELECT * FROM users WHERE name = ?',
        ['Nobody'],
      );
      expect(rows).toEqual([]);
    });

    it('WHERE clause filters in-memory after reading the full table', async () => {
      await store.execute('INSERT INTO t VALUES (?)', [10]);
      await store.execute('INSERT INTO t VALUES (?)', [20]);
      await store.execute('INSERT INTO t VALUES (?)', [30]);

      // The file-query store stores INSERT columns as "col0", "col1", etc.
      const rows = await store.execute('SELECT * FROM t WHERE col0 = ?', [20]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!).toEqual({ col0: 20 });
    });
  });

  // ─── INSERT INTO ───

  describe('INSERT INTO', () => {
    it('appends rows to the table file (white-box: verify file content)', async () => {
      await store.execute('INSERT INTO logs VALUES (?, ?)', ['event1', 100]);
      await store.execute('INSERT INTO logs VALUES (?, ?)', ['event2', 200]);

      const table = readTable(dataDir, 'logs');
      expect(table).toHaveLength(2);
      expect(table[0]).toEqual({ col0: 'event1', col1: 100 });
      expect(table[1]).toEqual({ col0: 'event2', col1: 200 });
    });

    it('creates the table file on first insert', async () => {
      expect(listTables(dataDir)).toEqual([]);

      await store.execute('INSERT INTO books VALUES (?)', ['Dune']);

      const tables = listTables(dataDir);
      expect(tables).toContain('books.json');
    });
  });

  // ─── Unsupported SQL ───

  describe('unsupported SQL', () => {
    it('returns empty array for unrecognised statement types', async () => {
      const rows = await store.execute('DELETE FROM users WHERE id = 1');
      expect(rows).toEqual([]);
    });

    it('returns empty for UPDATE statements', async () => {
      await store.execute('INSERT INTO t VALUES (?)', [1]);
      const rows = await store.execute('UPDATE t SET col0 = 2 WHERE col0 = 1');
      expect(rows).toEqual([]);

      // White-box: file unchanged
      const table = readTable(dataDir, 't');
      expect(table[0]!.col0).toBe(1);
    });
  });

  // ─── Edge cases ───

  describe('edge cases', () => {
    it('handles table names with numbers and underscores', async () => {
      await store.execute('INSERT INTO tbl_1 VALUES (?)', ['test']);
      const rows = await store.execute('SELECT * FROM tbl_1');
      expect(rows).toHaveLength(1);
    });

    it('case-insensitive SQL keywords', async () => {
      const { mkdirSync, writeFileSync } = require('node:fs');
      const queryDir = join(dataDir, 'query');
      mkdirSync(queryDir, { recursive: true });
      writeFileSync(join(queryDir, 'data.json'), JSON.stringify([{ v: 1 }]));

      const rows = await store.execute('select * from data');
      expect(rows).toHaveLength(1);
    });
  });
});
