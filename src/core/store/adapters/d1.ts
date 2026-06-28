/// <reference types="@cloudflare/workers-types" />

import type { IQueryStore, QueryParams } from '../interfaces.ts';

export class D1QueryStore implements IQueryStore {
  public constructor(private readonly db: D1Database) {}

  public async execute<T = unknown>(sql: string, params?: QueryParams): Promise<T[]> {
    const stmt = this.db.prepare(sql);

    let bound: D1PreparedStatement;
    if (params === undefined) {
      bound = stmt;
    } else if (Array.isArray(params)) {
      bound = stmt.bind(...params);
    } else {
      bound = stmt.bind(params);
    }

    const result = await bound.all<T>();
    return result.results;
  }
}
