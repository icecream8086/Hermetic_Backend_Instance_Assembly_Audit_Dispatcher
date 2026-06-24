import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { ILogWriter } from '../../core/audit/types.ts';
import { createFacility } from '../../core/brand.ts';
import { AppError } from '../../core/types.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import { KernLevel } from '../../core/audit/kern-level.ts';
import type { SysGroup, CreateSysGroupInput, UpdateSysGroupInput } from './types.ts';
import { generateSysGroupId } from './types.ts';

const FACILITY = createFacility('sysgrp');
const PREFIX = 'sysgroup:';
const IDS_SHARDS = 4;
const IDS_SHARD_PREFIX = 'sysgroup:idx:';
const COUNT_KEY = 'sysgroup:count';

/** Deterministic shard assignment from a sysgroup ID string. */
function sysgroupShard(id: string): number {
  let hash = 5381;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) + hash) + id.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % IDS_SHARDS;
}

export interface ISysGroupService {
  create(input: CreateSysGroupInput, actorId?: string): Promise<SysGroup>;
  list(): Promise<SysGroup[]>;
  listPaginated(page?: number, limit?: number, name?: string): Promise<{ items: SysGroup[]; total: number }>;
  get(id: string): Promise<SysGroup | null>;
  update(id: string, input: UpdateSysGroupInput, actorId?: string): Promise<SysGroup>;
  delete(id: string, actorId?: string): Promise<void>;
}

export class SysGroupService implements ISysGroupService {
  constructor(
    private readonly atomic: IAtomicStore,
    private readonly logger: ILogWriter,
    private readonly audit?: IAuditWriter,
  ) {}

  async create(input: CreateSysGroupInput, _actorId?: string): Promise<SysGroup> {
    const id = generateSysGroupId();
    const now = Date.now();
    const group: SysGroup = { id, name: input.name, description: input.description, rules: input.rules, priority: input.priority ?? 0, dependsOn: input.dependsOn ?? [], createdAt: now, updatedAt: now };
    await this.atomic.set(PREFIX + id, group, null);
    await this.#addToIndex(id);
    await this.#incrCounter().catch(() => {});
    await this.logger.write({ facility: FACILITY, level: KernLevel.INFO, message: `SysGroup created: ${input.name}`, metadata: { actorId: _actorId, groupId: id, priority: group.priority } });
    this.audit?.write({
      level: KernLevel.NOTICE,
      facility: FACILITY,
      message: `System group created — ${input.name}`,
      metadata: { eventType: 'sysgrp.created', groupId: id, actorId: _actorId },
    });
    return group;
  }

  async list(): Promise<SysGroup[]> {
    return this.#listAll();
  }

  async listPaginated(page = 1, limit = 50, name?: string): Promise<{ items: SysGroup[]; total: number }> {
    // When filtering by name, fall back to loading all items in memory
    if (name) {
      const all = await this.#listAll();
      const filtered = all.filter(g => g.name.toLowerCase().includes(name.toLowerCase()));
      const total = filtered.length;
      const start = (page - 1) * limit;
      return { items: filtered.slice(start, start + limit), total };
    }

    // Read total from counter (1 I/O) — avoids reading the full index.
    const countEntry = await this.atomic.get<number>(COUNT_KEY);
    const total = countEntry?.value ?? 0;
    if (total === 0) return { items: [], total };

    const start = (page - 1) * limit;
    if (start >= total) return { items: [], total };

    // Scan shards sequentially, collecting only enough IDs for the requested page.
    const pageIds: string[] = [];
    let remaining = limit;
    let skip = start;

    for (let i = 0; i < IDS_SHARDS && remaining > 0; i++) {
      const shard = await this.atomic.get<string[]>(IDS_SHARD_PREFIX + i);
      const ids = shard?.value ?? [];
      if (ids.length === 0) continue;

      if (skip >= ids.length) {
        skip -= ids.length;
        continue;
      }

      const take = Math.min(ids.length - skip, remaining);
      pageIds.push(...ids.slice(skip, skip + take));
      remaining -= take;
      skip = 0;
    }

    if (pageIds.length === 0) return { items: [], total };

    const entries = await Promise.all(pageIds.map(id => this.atomic.get<SysGroup>(PREFIX + id)));
    const items = entries.filter((e): e is NonNullable<typeof e> => e !== null).map(e => e.value);
    return { items, total };
  }

  async get(id: string): Promise<SysGroup | null> {
    const entry = await this.atomic.get<SysGroup>(PREFIX + id);
    return entry?.value ?? null;
  }

  async update(id: string, input: UpdateSysGroupInput, _actorId?: string): Promise<SysGroup> {
    const entry = await this.atomic.get<SysGroup>(PREFIX + id);
    if (!entry) throw new AppError(404, 'SYSGROUP_NOT_FOUND', 'System group not found');
    const updated: SysGroup = {
      ...entry.value,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description ?? undefined } : {}),
      ...(input.rules !== undefined ? { rules: input.rules } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.dependsOn !== undefined ? { dependsOn: input.dependsOn ?? [] } : {}),
      updatedAt: Date.now(),
    };
    const newVersion = await this.atomic.set(PREFIX + id, updated, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');
    this.audit?.write({
      level: KernLevel.INFO,
      facility: FACILITY,
      message: `System group updated — ${updated.name}`,
      metadata: { eventType: 'sysgrp.updated', groupId: id, actorId: _actorId },
    });
    return updated;
  }

  async delete(id: string, _actorId?: string): Promise<void> {
    const entry = await this.atomic.get<SysGroup>(PREFIX + id);
    if (!entry) throw new AppError(404, 'SYSGROUP_NOT_FOUND', 'System group not found');
    await this.atomic.set(PREFIX + id, null, entry.version);
    await this.#removeFromIndex(id);
    await this.#decrCounter().catch(() => {});
    await this.logger.write({ facility: FACILITY, level: KernLevel.WARNING, message: `SysGroup deleted: ${entry.value.name}`, metadata: { actorId: _actorId, groupId: id } });
    this.audit?.write({
      level: KernLevel.WARNING,
      facility: FACILITY,
      message: `System group deleted — ${entry.value.name}`,
      metadata: { eventType: 'sysgrp.deleted', groupId: id, actorId: _actorId },
    });
  }

  async #listAll(): Promise<SysGroup[]> {
    const shardKeys = Array.from({ length: IDS_SHARDS }, (_, i) => IDS_SHARD_PREFIX + i);
    const shards = await Promise.all(shardKeys.map(k => this.atomic.get<string[]>(k)));
    const allIds = shards.flatMap(s => s?.value ?? []);
    if (allIds.length === 0) return [];
    const entries = await Promise.all(allIds.map(id => this.atomic.get<SysGroup>(PREFIX + id)));
    return entries.filter((e): e is NonNullable<typeof e> => e !== null).map(e => e.value);
  }

  async #addToIndex(id: string): Promise<void> {
    const shardKey = IDS_SHARD_PREFIX + sysgroupShard(id);
    const entry = await this.atomic.get<string[]>(shardKey);
    const ids = entry?.value ?? [];
    ids.push(id);
    await this.atomic.set(shardKey, ids, entry?.version ?? null);
  }

  async #removeFromIndex(id: string): Promise<void> {
    const shardKey = IDS_SHARD_PREFIX + sysgroupShard(id);
    const entry = await this.atomic.get<string[]>(shardKey);
    if (!entry) return;
    const ids = entry.value.filter((i: string) => i !== id);
    await this.atomic.set(shardKey, ids, entry.version);
  }

  /** Best-effort counter increment. */
  async #incrCounter(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const entry = await this.atomic.get<number>(COUNT_KEY);
      const ver = await this.atomic.set(COUNT_KEY, (entry?.value ?? 0) + 1, entry?.version ?? null);
      if (ver) return;
    }
  }

  /** Best-effort counter decrement. */
  async #decrCounter(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const entry = await this.atomic.get<number>(COUNT_KEY);
      const cur = entry?.value ?? 0;
      if (cur <= 0) return;
      const ver = await this.atomic.set(COUNT_KEY, cur - 1, entry?.version ?? null);
      if (ver) return;
    }
  }
}
