import { z } from 'zod';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { IQueryStore, QueryParams } from '../interfaces.ts';

const { parse: parseJson } = JSON;

/** Check if params is an array using Zod (replaces Array.isArray). */
function isArrayParam(params: QueryParams | undefined): params is unknown[] {
  let result = false;
  try { z.array(z.unknown()).parse(params); result = true; } catch {
    console.debug("params is not an array");
  }
  return result;
}

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

  async #ensureDir(): Promise<void> {
    await mkdir(this.#dataDir, { recursive: true });
  }

  #tablePath(table: string): string {
    return join(this.#dataDir, `${table}.json`);
  }

  async #readTable(table: string): Promise<Record<string, unknown>[]> {
    let rows: Record<string, unknown>[] = [];
    try {
      const raw = await readFile(this.#tablePath(table), 'utf-8');
      rows = z.custom<Record<string, unknown>[]>().parse(parseJson(raw));
    } catch (_e) {
      console.debug("table not found", _e);
    }
    return rows;
  }

  async #writeTable(table: string, rows: Record<string, unknown>[]): Promise<void> {
    await writeFile(this.#tablePath(table), JSON.stringify(rows), 'utf-8');
  }

  public async execute<T = unknown>(sql: string, params?: QueryParams): Promise<T[]> {
    await this.#ensureDir();

    // Minimal SQL parser: supports SELECT * FROM <table> WHERE <col> = <val>
    const selectMatch = /SELECT\s+\*\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?/i.exec(sql);
    if (selectMatch) {
      const tableGroup = selectMatch[1];
      if (tableGroup === undefined) return [];
      let rows = await this.#readTable(tableGroup);

      if (selectMatch[2]) {
        const whereClause = selectMatch[2].trim();
        // Simple WHERE col = $1
        const whereMatch = /(\w+)\s*=\s*\?/.exec(whereClause);
        if (whereMatch) {
          const col = whereMatch[1];
          if (col !== undefined && isArrayParam(params)) {
            rows = rows.filter(r => r[col] === params[0]);
          }
        }
      }

      return z.custom<T[]>().parse(rows);
    }

    // INSERT INTO <table> VALUES (...)
    const insertMatch = /INSERT\s+INTO\s+(\w+)\s+VALUES\s*\((.+)\)/i.exec(sql);
    if (insertMatch) {
      const tableGroup = insertMatch[1];
      if (tableGroup === undefined) return [];
      const rows = await this.#readTable(tableGroup);
      // Very naive — just appends params as a row
      if (isArrayParam(params)) {
        const newRow: Record<string, unknown> = {};
        for (let i = 0; i < params.length; i++) {
          const p = params[i];
          newRow[`col${String(i)}`] = p;
        }
        rows.push(newRow);
        await this.#writeTable(tableGroup, rows);
      }
      return [];
    }

    // Unsupported — return empty for dev
    return [];
  }
}
