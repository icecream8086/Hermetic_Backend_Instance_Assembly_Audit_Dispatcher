import type { IAtomicStore } from '../../core/store/interfaces.ts';
import { TransactConflictError } from '../../core/store/interfaces.ts';
import type { ILogWriter } from '../../core/audit/types.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import type { Volume } from '../sandbox/types.ts';
import { VolumeStatus, createVolumeId } from '../sandbox/types.ts';
import type { CreateVolumeInput, UpdateVolumeInput } from './types.ts';
import { AppError } from '../../core/types.ts';
import type { PaginatedResult, ICrudService } from '../../core/crud/index.ts';

const PREFIX = 'volume:';
const INDEX_KEY = 'volume:ids';
const NOT_FOUND = 'VOLUME_NOT_FOUND';

export interface IVolumeService extends ICrudService<Volume, CreateVolumeInput, UpdateVolumeInput> {
  listPaginated(page?: number, limit?: number, filters?: Record<string, string>): Promise<PaginatedResult<Volume>>;
}

export class VolumeService implements IVolumeService {
  constructor(
    private readonly atomic: IAtomicStore,
    private readonly logger: ILogWriter,
    _audit?: IAuditWriter,
  ) {}

  /** Validate that an instanceId refers to an existing ComputeInstance. */
  async #validateInstance(instanceId: string): Promise<void> {
    const { InstanceService } = await import('../../core/region/instance.ts');
    const svc = new InstanceService(this.atomic);
    const inst = await svc.get(instanceId as any);
    if (!inst) throw new AppError(400, 'INSTANCE_NOT_FOUND', `ComputeInstance ${instanceId} not found`);
  }

  async create(input: CreateVolumeInput): Promise<Volume> {
    // Validate that the target ComputeInstance exists
    if (input.instanceId) await this.#validateInstance(input.instanceId);

    const now = Date.now();
    const id = createVolumeId(crypto.randomUUID());

    const volume: Volume = {
      id,
      name: input.name,
      tags: [],
      createdAt: now,
      updatedAt: now,
      status: VolumeStatus.Detached,
      type: input.type,
      instanceId: input.instanceId,
      ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.nfs ? { nfs: input.nfs } : {}),
      ...(input.disk ? { disk: input.disk } : {}),
      ...(input.secret ? { secret: input.secret } : {}),
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.atomic.transact(async (txn) => {
          const idx = await txn.get<string[]>(INDEX_KEY);
          txn.set(INDEX_KEY, [...(idx ?? []), id]);
          txn.set(PREFIX + id, volume);
        });
        break;
      } catch (err) {
        if (err instanceof TransactConflictError && attempt < 2) continue;
        throw err;
      }
    }

    this.logger.write({ facility: 'app' as any, level: 'INFO' as any, message: `[volume] Created ${input.type}: ${id} (${input.name})` });
    return volume;
  }

  async get(id: string): Promise<Volume | null> {
    const entry = await this.atomic.get<Volume>(PREFIX + id);
    if (!entry) return null;
    return entry.value;
  }

  async listPaginated(page = 1, limit = 50, filters?: Record<string, string>): Promise<PaginatedResult<Volume>> {
    const idsEntry = await this.atomic.get<string[]>(INDEX_KEY);
    const allIds = idsEntry?.value ?? [];
    const hasFilter = filters && (filters.name || filters.type || filters.status || filters.instanceId);

    // Load all, filter in memory, then paginate
    const allItems = hasFilter
      ? (await Promise.all(allIds.map(id => this.atomic.get<Volume>(PREFIX + id))))
          .filter((e): e is NonNullable<typeof e> => Boolean(e))
          .map(e => e.value)
      : [];

    let items: Volume[];
    let total: number;

    if (hasFilter) {
      items = allItems.filter(v => {
        if (filters.name && !(v.name ?? '').toLowerCase().includes(filters.name.toLowerCase())) return false;
        if (filters.type && v.type !== filters.type) return false;
        if (filters.status && v.status !== filters.status) return false;
        if (filters.instanceId && v.instanceId !== filters.instanceId) return false;
        return true;
      });
      total = items.length;
      items = items.slice((page - 1) * limit, (page - 1) * limit + limit);
    } else {
      total = allIds.length;
      const pageIds = allIds.slice((page - 1) * limit, (page - 1) * limit + limit);
      const entries = await Promise.all(pageIds.map(id => this.atomic.get<Volume>(PREFIX + id)));
      items = entries.filter((e): e is NonNullable<typeof e> => Boolean(e)).map(e => e.value);
    }

    return { items, total, page, limit };
  }

  async list(page?: number, limit?: number): Promise<PaginatedResult<Volume>> {
    return this.listPaginated(page, limit);
  }

  async update(id: string, input: UpdateVolumeInput): Promise<Volume> {
    const entry = await this.atomic.get<Volume>(PREFIX + id);
    if (!entry) throw new AppError(404, NOT_FOUND, `${NOT_FOUND}: ${id}`);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let updated: Volume | null = null;
        await this.atomic.transact<void>(async (txn) => {
          const raw: Volume | null = await txn.get<Volume>(PREFIX + id);
          if (!raw) throw new AppError(404, NOT_FOUND, `${NOT_FOUND}: ${id}`);

          const desc = input.description;
          const merged: Volume = {
            ...raw,
            updatedAt: Date.now(),
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(desc !== undefined && desc !== null ? { description: desc } : {}),
            ...(input.instanceId ? { instanceId: input.instanceId } : {}),
            ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
            ...(input.nfs ? { nfs: input.nfs } : {}),
            ...(input.disk ? { disk: input.disk } : {}),
            ...(input.secret ? { secret: input.secret } : {}),
          };

          txn.set(PREFIX + id, merged);
          updated = merged;
        });
        this.logger.write({ facility: 'app' as any, level: 'INFO' as any, message: `[volume] Updated ${id}` });
        return updated!;
      } catch (err) {
        if (err instanceof TransactConflictError && attempt < 2) continue;
        throw err;
      }
    }
    throw new AppError(409, 'CONFLICT', 'Concurrent modification detected after 3 retries');
  }

  async delete(id: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.atomic.transact<void>(async (txn) => {
          const existing = await txn.get<Volume>(PREFIX + id);
          if (!existing) throw new AppError(404, NOT_FOUND, `${NOT_FOUND}: ${id}`);
          const idx = await txn.get<string[]>(INDEX_KEY);
          if (idx) txn.set(INDEX_KEY, idx.filter((i: string) => i !== id));
          txn.set<Volume | null>(PREFIX + id, null);
        });
        break;
      } catch (err) {
        if (err instanceof TransactConflictError && attempt < 2) continue;
        throw err;
      }
    }
    this.logger.write({ facility: 'app' as any, level: 'INFO' as any, message: `[volume] Deleted ${id}` });
  }
}
