/// <reference types="@cloudflare/workers-types" />

import { z } from 'zod';
import type { IQueryStore, QueryParams } from '../interfaces.ts';

export class D1QueryStore implements IQueryStore {
  public constructor(private readonly db: D1Database) {}

  public async execute<T = unknown>(sql: string, params?: QueryParams): Promise<T[]> {
    const stmt = this.db.prepare(sql);

    let bound: D1PreparedStatement;
    if (params === undefined) {
      bound = stmt;
    } else {
      try {
        const arrParams = z.array(z.unknown()).parse(params);
        bound = stmt.bind(...arrParams);
      } catch {
        bound = stmt.bind(params);
      }
    }

    const result = await bound.all<T>();
    return result.results;
  }
}
