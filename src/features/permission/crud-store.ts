import type { IAtomicStore } from '../../core/store/interfaces.ts';
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
  async listPaginated(page = 1, limit = 50): Promise<PaginatedResult<T>> {
    const idsEntry = await this.atomic.get<string[]>(this.indexKey);
    const allIds = idsEntry?.value ?? [];
    const total = allIds.length;

    const start = (page - 1) * limit;
    const pageIds = allIds.slice(start, start + limit);
    const entries = await Promise.all(
      pageIds.map(id => this.atomic.get<T>(this.prefix + id)),
    );
    const items = entries
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .map(e => e.value);

    return { items, total, page, limit };
  }

  async get(id: string): Promise<T | null> {
    const entry = await this.atomic.get<T>(this.prefix + id);
    return entry?.value ?? null;
  }

  async delete(id: string): Promise<T> {
    const entry = await this.atomic.get<T>(this.prefix + id);
    if (!entry) throw new AppError(404, this.notFoundCode, `${this.notFoundCode}: ${id}`);
    await this.atomic.set(this.prefix + id, null, entry.version);
    await this.#removeFromIndex(id);
    return entry.value;
  }

  async insert(entity: T): Promise<void> {
    await this.atomic.set(this.prefix + entity.id, entity, null);
    await this.#addToIndex(entity.id);
  }

  async commitUpdate(id: string, updated: T, expectedVersion: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const ver = await this.atomic.set(this.prefix + id, updated, expectedVersion as any);
      if (ver) return;
      const entry = await this.atomic.get<T>(this.prefix + id);
      if (!entry) throw new AppError(404, this.notFoundCode, `${this.notFoundCode}: ${id}`);
      expectedVersion = entry.version;
      updated = { ...entry.value, ...updated, updatedAt: Date.now() };
    }
    throw new AppError(409, 'CONFLICT', 'Concurrent modification detected after 3 retries');
  }

  async #loadAll(): Promise<T[]> {
    const entry = await this.atomic.get<string[]>(this.indexKey);
    if (!entry || !entry.value.length) return [];
    const entries = await Promise.all(
      entry.value.map(id => this.atomic.get<T>(this.prefix + id)),
    );
    return entries
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .map(e => e.value);
  }

  async #addToIndex(id: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const entry = await this.atomic.get<string[]>(this.indexKey);
      const ids = entry?.value ?? [];
      ids.push(id);
      const ver = await this.atomic.set(this.indexKey, ids, entry?.version ?? null);
      if (ver) return;
    }
  }

  async #removeFromIndex(id: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const entry = await this.atomic.get<string[]>(this.indexKey);
      if (!entry) return;
      const ids = entry.value.filter((i: string) => i !== id);
      const ver = await this.atomic.set(this.indexKey, ids, entry.version);
      if (ver) return;
    }
  }
}
