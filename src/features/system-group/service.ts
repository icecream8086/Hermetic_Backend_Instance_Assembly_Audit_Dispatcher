import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { ILogWriter } from '../../core/logger/interfaces.ts';
import { createFacility } from '../../core/brand.ts';
import { LogLevel, AppError } from '../../core/types.ts';
import type { SysGroup, CreateSysGroupInput, UpdateSysGroupInput } from './types.ts';
import { generateSysGroupId } from './types.ts';

const FACILITY = createFacility('sysgrp');
const PREFIX = 'sysgroup:';
const INDEX_KEY = 'sysgroup:ids';

export interface ISysGroupService {
  create(input: CreateSysGroupInput, actorId?: string): Promise<SysGroup>;
  list(): Promise<SysGroup[]>;
  get(id: string): Promise<SysGroup | null>;
  update(id: string, input: UpdateSysGroupInput, actorId?: string): Promise<SysGroup>;
  delete(id: string, actorId?: string): Promise<void>;
}

export class SysGroupService implements ISysGroupService {
  constructor(
    private readonly atomic: IAtomicStore,
    private readonly logger: ILogWriter,
  ) {}

  async create(input: CreateSysGroupInput, _actorId?: string): Promise<SysGroup> {
    const id = generateSysGroupId();
    const now = Date.now();
    const group: SysGroup = { id, name: input.name, description: input.description, rules: input.rules, priority: input.priority ?? 0, dependsOn: input.dependsOn ?? [], createdAt: now, updatedAt: now };
    await this.atomic.set(PREFIX + id, group, null);
    await this.#addToIndex(id);
    await this.logger.logAsync({ facility: FACILITY, level: LogLevel.INFO, message: `SysGroup created: ${input.name}`, metadata: { actorId: _actorId, groupId: id, priority: group.priority } });
    return group;
  }

  async list(): Promise<SysGroup[]> {
    return this.#listAll();
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
    return updated;
  }

  async delete(id: string, _actorId?: string): Promise<void> {
    const entry = await this.atomic.get<SysGroup>(PREFIX + id);
    if (!entry) throw new AppError(404, 'SYSGROUP_NOT_FOUND', 'System group not found');
    await this.atomic.set(PREFIX + id, null, entry.version);
    await this.#removeFromIndex(id);
    await this.logger.logAsync({ facility: FACILITY, level: LogLevel.WARN, message: `SysGroup deleted: ${entry.value.name}`, metadata: { actorId: _actorId, groupId: id } });
  }

  async #listAll(): Promise<SysGroup[]> {
    const entry = await this.atomic.get<string[]>(INDEX_KEY);
    if (!entry || !entry.value.length) return [];
    const entries = await Promise.all(entry.value.map(id => this.atomic.get<SysGroup>(PREFIX + id)));
    return entries.filter((e): e is NonNullable<typeof e> => e !== null).map(e => e.value);
  }

  async #addToIndex(id: string): Promise<void> {
    const entry = await this.atomic.get<string[]>(INDEX_KEY);
    const ids = entry?.value ?? [];
    ids.push(id);
    await this.atomic.set(INDEX_KEY, ids, entry?.version ?? null);
  }

  async #removeFromIndex(id: string): Promise<void> {
    const entry = await this.atomic.get<string[]>(INDEX_KEY);
    if (!entry) return;
    const ids = entry.value.filter((i: string) => i !== id);
    await this.atomic.set(INDEX_KEY, ids, entry.version);
  }
}
