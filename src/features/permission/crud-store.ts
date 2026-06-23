import type { IAtomicStore } from '../../core/store/interfaces.ts';
import { TransactConflictError } from '../../core/store/interfaces.ts';
import { AppError } from '../../core/types.ts';

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Generic CRUD store operations for permission entities.
 */
export class CrudStore<T extends { id: string }> {
  constructor(
    private readonly atomic: IAtomicStore,
    private readonly prefix: string,
    private readonly indexKey: string,
    private readonly notFoundCode: string,
  ) {}

  /** Return all entities (unpaginated — for internal evaluation use). */
  async list(): Promise<T[]> {
    return this.#loadAll();
  }

  /** Return a page of entities. Defaults to page 1, limit 50. */
  async listPaginated(page = 1, limit = 50, filter?: (item: T) => boolean): Promise<PaginatedResult<T>> {
    // Apply filter before pagination: load all items, filter, then slice
    const allItems = await this.#loadAll();
    let items = filter ? allItems.filter(filter) : allItems;
    const total = items.length;

    const start = (page - 1) * limit;
    items = items.slice(start, start + limit);

    return { items, total, page, limit };
  }

  async get(id: string): Promise<T | null> {
    const entry = await this.atomic.get<T>(this.prefix + id);
    return entry?.value ?? null;
  }

  async delete(id: string): Promise<T> {
    const entry = await this.atomic.get<T>(this.prefix + id);
    if (!entry) throw new AppError(404, this.notFoundCode, `${this.notFoundCode}: ${id}`);
    // Atomically remove entity + update index
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.atomic.transact(async (txn) => {
          const e = await txn.get<T>(this.prefix + id);
          if (!e) throw new AppError(404, this.notFoundCode, `${this.notFoundCode}: ${id}`);
          const idx = await txn.get<string[]>(this.indexKey);
          if (idx) txn.set(this.indexKey, idx.filter((i: string) => i !== id));
          txn.set(this.prefix + id, null);
        });
        break;
      } catch (err) {
        if (err instanceof TransactConflictError && attempt < 2) continue;
        throw err;
      }
    }
    return entry.value;
  }

  async insert(entity: T): Promise<void> {
    // Atomically create entity + update index
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.atomic.transact(async (txn) => {
          const existing = await txn.get<T>(this.prefix + entity.id);
          if (existing) throw new AppError(409, 'CONFLICT', `${this.notFoundCode}: id ${entity.id} already exists`);
          const idx = await txn.get<string[]>(this.indexKey);
          txn.set(this.indexKey, [...(idx ?? []), entity.id]);
          txn.set(this.prefix + entity.id, entity);
        });
        break;
      } catch (err) {
        if (err instanceof TransactConflictError && attempt < 2) continue;
        throw err;
      }
    }
  }

  async commitUpdate(id: string, updated: T): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const entry = await this.atomic.get<T>(this.prefix + id);
      if (!entry) throw new AppError(404, this.notFoundCode, `${this.notFoundCode}: ${id}`);
      updated = { ...entry.value, ...updated, updatedAt: Date.now() } as T;
      const ver = await this.atomic.set(this.prefix + id, updated, entry.version);
      if (ver) return;
    }
    throw new AppError(409, 'CONFLICT', 'Concurrent modification detected after 3 retries');
  }

  /** Load all entities — uses transact().getMany() to batch DO reads into 1 round-trip. */
  async #loadAll(): Promise<T[]> {
    return this.atomic.transact(async (txn) => {
      const idxEntry = await txn.get<string[]>(this.indexKey);
      if (!idxEntry || !idxEntry.length) return [];
      const keys = idxEntry.map(id => this.prefix + id);
      const entries = await txn.getMany<T>(keys);
      return entries.filter((e: T | null): e is T => e !== null);
    });
  }

}
