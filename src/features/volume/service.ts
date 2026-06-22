import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { ILogWriter } from '../../core/logger/interfaces.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import type { Volume } from '../sandbox/types.ts';
import { VolumeStatus, createVolumeId } from '../sandbox/types.ts';
import type { CreateVolumeInput, UpdateVolumeInput } from './types.ts';
import { AppError } from '../../core/types.ts';
import { TransactConflictError } from '../../core/store/interfaces.ts';

const PREFIX = 'volume:';
const INDEX_KEY = 'volume:ids';
const NOT_FOUND = 'VOLUME_NOT_FOUND';

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

export interface IVolumeService {
  create(input: CreateVolumeInput): Promise<Volume>;
  get(id: string): Promise<Volume | null>;
  listPaginated(page?: number, limit?: number, filters?: Record<string, string>): Promise<PaginatedResult<Volume>>;
  update(id: string, input: UpdateVolumeInput): Promise<Volume>;
  delete(id: string): Promise<void>;
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

    const volume: Record<string, unknown> = {
      id,
      name: input.name,
      tags: [],
      createdAt: now,
      updatedAt: now,
      status: VolumeStatus.Detached,
      type: input.type,
    };
    volume.instanceId = input.instanceId;
    if (input.credentialRef) volume.credentialRef = input.credentialRef;
    if (input.description) volume.description = input.description;
    if (input.nfs) volume.nfs = input.nfs;
    if (input.disk) volume.disk = input.disk;
    if (input.secret) volume.secret = input.secret;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.atomic.transact(async (txn) => {
          const idx = await (txn as any).get(INDEX_KEY);
          (txn as any).set(INDEX_KEY, [...(idx ?? []), id]);
          (txn as any).set(PREFIX + id, volume);
        });
        break;
      } catch (err) {
        if (err instanceof TransactConflictError && attempt < 2) continue;
        throw err;
      }
    }

    this.logger.logAsync({ facility: 'app' as any, level: 'INFO' as any, message: `[volume] Created ${input.type}: ${id} (${input.name})` });
    return volume as unknown as Volume;
  }

  async get(id: string): Promise<Volume | null> {
    const entry = await this.atomic.get<Record<string, unknown>>(PREFIX + id);
    if (!entry) return null;
    return entry.value as unknown as Volume;
  }

  async listPaginated(page = 1, limit = 50, filters?: Record<string, string>): Promise<PaginatedResult<Volume>> {
    const idsEntry = await this.atomic.get<string[]>(INDEX_KEY);
    const allIds = idsEntry?.value ?? [];
    const hasFilter = filters && (filters.name || filters.type || filters.status || filters.instanceId);

    // Load all, filter in memory, then paginate
    const allItems = hasFilter
      ? (await Promise.all(allIds.map(id => this.atomic.get<Record<string, unknown>>(PREFIX + id))))
          .filter(Boolean)
          .map(e => e!.value as unknown as Volume)
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
      const entries = await Promise.all(pageIds.map(id => this.atomic.get<Record<string, unknown>>(PREFIX + id)));
      items = entries.filter(Boolean).map(e => (e!.value as unknown as Volume));
    }

    return { items, total, page, limit };
  }

  async update(id: string, input: UpdateVolumeInput): Promise<Volume> {
    const entry = await this.atomic.get<Record<string, unknown>>(PREFIX + id);
    if (!entry) throw new AppError(404, NOT_FOUND, `${NOT_FOUND}: ${id}`);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let updated: Volume | null = null;
        await this.atomic.transact<void>(async (txn) => {
          const raw = await (txn as any).get(PREFIX + id);
          if (!raw) throw new AppError(404, NOT_FOUND, `${NOT_FOUND}: ${id}`);

          const merged: Record<string, unknown> = { ...raw, updatedAt: Date.now() };
          if (input.name !== undefined) merged.name = input.name;
          if (input.description !== undefined) merged.description = input.description ?? undefined;
          if (input.instanceId !== undefined) merged.instanceId = input.instanceId ?? undefined;
          if (input.credentialRef !== undefined) merged.credentialRef = input.credentialRef ?? undefined;
          if (input.nfs !== undefined) merged.nfs = input.nfs ?? undefined;
          if (input.disk !== undefined) merged.disk = input.disk ?? undefined;
          if (input.secret !== undefined) merged.secret = input.secret ?? undefined;

          (txn as any).set(PREFIX + id, merged);
          updated = merged as unknown as Volume;
        });
        this.logger.logAsync({ facility: 'app' as any, level: 'INFO' as any, message: `[volume] Updated ${id}` });
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
          const existing = await (txn as any).get(PREFIX + id);
          if (!existing) throw new AppError(404, NOT_FOUND, `${NOT_FOUND}: ${id}`);
          const idx = await (txn as any).get(INDEX_KEY);
          if (idx) (txn as any).set(INDEX_KEY, idx.filter((i: string) => i !== id));
          (txn as any).set(PREFIX + id, null);
        });
        break;
      } catch (err) {
        if (err instanceof TransactConflictError && attempt < 2) continue;
        throw err;
      }
    }
    this.logger.logAsync({ facility: 'app' as any, level: 'INFO' as any, message: `[volume] Deleted ${id}` });
  }
}
