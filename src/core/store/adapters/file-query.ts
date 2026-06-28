import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { IQueryStore, QueryParams } from '../interfaces.ts';

/**
 * Local file-based query store for Node.js development.
 * Each "table" is a JSON file containing an array of objects.
 * Supports a very limited subset of SQL — just enough for dev.
 */
export class FileQueryStore implements IQueryStore {
  #dataDir: string;

  public constructor(basePath: string) {
    this.#dataDir = resolve(basePath, 'query');
  }

  public async #ensureDir(): Promise<void> {
    await mkdir(this.#dataDir, { recursive: true });
  }

  #tablePath(table: string): string {
    return join(this.#dataDir, `${table}.json`);
  }

  public async #readTable(table: string): Promise<Record<string, unknown>[]> {
    try {
      const raw = await readFile(this.#tablePath(table), 'utf-8');
      return JSON.parse(raw) as Record<string, unknown>[];
    } catch {
      return [];
    }
  }

  public async #writeTable(table: string, rows: Record<string, unknown>[]): Promise<void> {
    await writeFile(this.#tablePath(table), JSON.stringify(rows), 'utf-8');
  }

  public async execute<T = unknown>(sql: string, params?: QueryParams): Promise<T[]> {
    await this.#ensureDir();

    // Minimal SQL parser: supports SELECT * FROM <table> WHERE <col> = <val>
    const selectMatch = /SELECT\s+\*\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?/i.exec(sql);
    if (selectMatch) {
      const table = selectMatch[1]!;
      let rows = await this.#readTable(table);

      if (selectMatch[2]) {
        const whereClause = selectMatch[2].trim();
        // Simple WHERE col = $1
        const whereMatch = /(\w+)\s*=\s*\?/.exec(whereClause);
        if (whereMatch && Array.isArray(params)) {
          const col = whereMatch[1]!;
          rows = rows.filter(r => r[col] === params[0]);
        }
      }

      return rows as T[];
    }

    // INSERT INTO <table> VALUES (...)
    const insertMatch = /INSERT\s+INTO\s+(\w+)\s+VALUES\s*\((.+)\)/i.exec(sql);
    if (insertMatch) {
      const table = insertMatch[1]!;
      const rows = await this.#readTable(table);
      // Very naive — just appends params as a row
      if (Array.isArray(params)) {
        const newRow: Record<string, unknown> = {};
        for (let i = 0; i < params.length; i++) {
          newRow[`col${i}`] = params[i];
        }
        rows.push(newRow);
        await this.#writeTable(table, rows);
      }
      return [] as T[];
    }

    // Unsupported — return empty for dev
    return [] as T[];
  }
}
