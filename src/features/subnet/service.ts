import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { ILogWriter } from '../../core/logger/interfaces.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import { createFacility } from '../../core/brand.ts';
import { LogLevel, AppError } from '../../core/types.ts';
import { KernLevel } from '../../core/audit/kern-level.ts';
import { parseCidr } from '../../core/network/cidr.ts';
import { InstanceService } from '../../core/region/instance.ts';
import type { Subnet, SubnetId, SubnetStatus, CreateSubnetInput, UpdateSubnetInput } from './types.ts';
import { generateSubnetId } from './types.ts';

const FACILITY = createFacility('subnet');
const PREFIX = 'subnet:';
const INDEX_KEY = 'subnet:ids';

export interface ISubnetService {
  create(input: CreateSubnetInput, actorId?: string): Promise<Subnet>;
  list(page?: number, limit?: number): Promise<{ items: Subnet[]; total: number; page: number; limit: number }>;
  get(id: SubnetId): Promise<Subnet | null>;
  update(id: SubnetId, input: UpdateSubnetInput, actorId?: string): Promise<Subnet>;
  delete(id: SubnetId, actorId?: string): Promise<void>;
}

export class SubnetService implements ISubnetService {
  constructor(
    private readonly atomic: IAtomicStore,
    private readonly logger: ILogWriter,
    private readonly audit?: IAuditWriter,
    private readonly instanceSvc?: InstanceService,
  ) {}

  async create(input: CreateSubnetInput, actorId?: string): Promise<Subnet> {
    try { parseCidr(input.cidr); } catch { throw new AppError(400, 'INVALID_CIDR', `Invalid CIDR: ${input.cidr}`); }

    const inst = this.instanceSvc ? await this.instanceSvc.get(input.instanceId) : null;
    if (!inst) throw new AppError(400, 'INSTANCE_NOT_FOUND', `ComputeInstance ${input.instanceId} not found`);

    const id = generateSubnetId();
    const now = Date.now();

    const subnet: Subnet = {
      id, name: input.name, description: input.description,
      cidr: input.cidr, subnetPrefix: input.subnetPrefix,
      instanceId: input.instanceId, provider: inst.platform, region: inst.region,
      visibility: input.visibility ?? 'private', creatorId: actorId,
      userIds: input.userIds ?? [], userGroupIds: input.userGroupIds ?? [],
      status: 'Active', createdAt: now, updatedAt: now,
    };

    await this.atomic.set(PREFIX + id, subnet, null);
    await this.#addToIndex(id);

    await this.logger.logAsync({ facility: FACILITY, level: LogLevel.INFO, message: `Subnet created: ${input.name} (${input.cidr})`, actorId: actorId });
    this.audit?.write({ level: KernLevel.NOTICE, facility: FACILITY, message: `Subnet created — ${input.name} (${input.cidr})`, actorId, metadata: { eventType: 'subnet.created' } });

    return subnet;
  }

  async list(page = 1, limit = 20): Promise<{ items: Subnet[]; total: number; page: number; limit: number }> {
    const all = (await this.#listAll()).reverse();
    const total = all.length;
    const start = (page - 1) * limit;
    return { items: all.slice(start, start + limit), total, page, limit };
  }

  async get(id: SubnetId): Promise<Subnet | null> {
    const entry = await this.atomic.get<Subnet>(PREFIX + id);
    return entry?.value ?? null;
  }

  async update(id: SubnetId, input: UpdateSubnetInput, _actorId?: string): Promise<Subnet> {
    const entry = await this.atomic.get<Subnet>(PREFIX + id);
    if (!entry) throw new AppError(404, 'SUBNET_NOT_FOUND', 'Subnet not found');

    const updated: Subnet = {
      ...entry.value,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description ?? undefined } : {}),
      ...(input.cidr !== undefined ? { cidr: input.cidr } : {}),
      ...(input.subnetPrefix !== undefined ? { subnetPrefix: input.subnetPrefix } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      ...(input.userIds !== undefined ? { userIds: input.userIds ?? [] } : {}),
      ...(input.userGroupIds !== undefined ? { userGroupIds: input.userGroupIds ?? [] } : {}),
      ...(input.status !== undefined ? { status: input.status as SubnetStatus } : {}),
      updatedAt: Date.now(),
    };

    const newVersion = await this.atomic.set(PREFIX + id, updated, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');
    return updated;
  }

  async delete(id: SubnetId, actorId?: string): Promise<void> {
    const entry = await this.atomic.get<Subnet>(PREFIX + id);
    if (!entry) throw new AppError(404, 'SUBNET_NOT_FOUND', 'Subnet not found');
    await this.atomic.set(PREFIX + id, null, entry.version);
    await this.#removeFromIndex(id);
    this.audit?.write({ level: KernLevel.WARNING, facility: FACILITY, message: `Subnet deleted — ${entry.value.name}`, actorId, metadata: { eventType: 'subnet.deleted' } });
  }

  async #listAll(): Promise<Subnet[]> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    if (!idx) return [];
    const entries = await Promise.all(idx.value.map(id => this.atomic.get<Subnet>(PREFIX + id)));
    return entries.filter(e => e).map(e => e!.value);
  }
  async #addToIndex(id: SubnetId): Promise<void> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    await this.atomic.set(INDEX_KEY, [...(idx?.value ?? []), id], idx?.version ?? null);
  }
  async #removeFromIndex(id: SubnetId): Promise<void> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    if (!idx) return;
    await this.atomic.set(INDEX_KEY, idx.value.filter((i: string) => i !== id), idx.version);
  }
}
