import type { PaginatedResult } from './types.ts';

/**
 * Reference CRUD service contract.
 *
 * Services with standard CRUD semantics should structurally satisfy this
 * interface. For nominal enforcement, extend it:
 *
 *   export interface IVolumeService extends ICrudService<Volume, CreateInput, UpdateInput> {}
 *
 * Services with extra methods (uploadBlob, resolveData, etc.) extend and
 * add their own methods — the base interface guarantees create/get/list/
 * update/delete are all present.
 */
export interface ICrudService<
  TEntity,
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- generic CRUD: TEntity is unbounded, Partial is the only way to express "all fields optional for create"
  TCreate = Partial<TEntity>,
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- generic CRUD: same rationale as TCreate
  TUpdate = Partial<TEntity>,
  TId = string,
> {
  create(input: TCreate): Promise<TEntity>;
  get(id: TId): Promise<TEntity | null>;
  list(page?: number, limit?: number): Promise<PaginatedResult<TEntity>>;
  update(id: TId, input: TUpdate): Promise<TEntity>;
  delete(id: TId): Promise<void>;
}
