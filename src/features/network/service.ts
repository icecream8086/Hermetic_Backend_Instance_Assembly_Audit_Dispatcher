import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { ILogWriter } from '../../core/audit/types.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import type { INetworkPolicyProvider } from '../../core/provider/interfaces.ts';
import { createFacility } from '../../core/brand.ts';
import { AppError } from '../../core/types.ts';
import { KernLevel } from '../../core/audit/kern-level.ts';
import { InstanceService } from '../../core/region/instance.ts';
import type {
  SecurityGroup, SecurityGroupId, SecurityGroupStatus,
  CreateSecurityGroupInput, UpdateSecurityGroupInput,
} from './types.ts';
import { generateSecurityGroupId } from './types.ts';

const FACILITY = createFacility('secgroup');
const PREFIX = 'secgroup:';
const INDEX_KEY = 'secgroup:ids';

export interface ISecurityGroupService {
  create(input: CreateSecurityGroupInput, actorId?: string): Promise<SecurityGroup>;
  list(page?: number, limit?: number, name?: string): Promise<{ items: SecurityGroup[]; total: number; page: number; limit: number }>;
  get(id: SecurityGroupId): Promise<SecurityGroup | null>;
  update(id: SecurityGroupId, input: UpdateSecurityGroupInput, actorId?: string): Promise<SecurityGroup>;
  delete(id: SecurityGroupId, actorId?: string): Promise<void>;
}

export class SecurityGroupService implements ISecurityGroupService {
  constructor(
    private readonly atomic: IAtomicStore,
    private readonly logger: ILogWriter,
    private readonly audit?: IAuditWriter,
    private readonly networkPolicy?: INetworkPolicyProvider | undefined,
    private readonly instanceSvc?: InstanceService | undefined,
  ) {}

  async create(input: CreateSecurityGroupInput, actorId?: string): Promise<SecurityGroup> {
    const inst = this.instanceSvc ? await this.instanceSvc.get(input.instanceId) : null;
    if (!inst) throw new AppError(400, 'INSTANCE_NOT_FOUND', `ComputeInstance ${input.instanceId} not found`);

    const id = generateSecurityGroupId();
    const now = Date.now();

    // Provision cloud-side resource if provider is available
    let providerNetworkId: string | undefined;
    if (this.networkPolicy) {
      try {
        providerNetworkId = await this.networkPolicy.ensureNetwork(id);
        if (input.rules?.length && this.networkPolicy.applyRules) {
          await this.networkPolicy.applyRules(providerNetworkId, input.rules);
        }
      } catch (e: any) {
        throw new AppError(502, 'PROVIDER_ERROR', `Failed to provision security group: ${e.message}`);
      }
    }

    const sg: SecurityGroup = {
      id, name: input.name, description: input.description,
      ...(input.securityGroupId ? { securityGroupId: input.securityGroupId } : {}),
      ...(input.rules?.length ? { rules: input.rules } : {}),
      ...(input.bandwidth ? { bandwidth: input.bandwidth } : {}),
      ...(providerNetworkId ? { providerNetworkId } : {}),
      instanceId: input.instanceId, provider: inst.platform, region: inst.region,
      visibility: input.visibility ?? 'private', creatorId: actorId,
      userIds: input.userIds ?? [], userGroupIds: input.userGroupIds ?? [],
      status: 'Active', createdAt: now, updatedAt: now,
    };

    await this.atomic.set(PREFIX + id, sg, null);
    await this.#addToIndex(id);

    await this.logger.write({ facility: FACILITY, level: KernLevel.INFO, message: `Security group created: ${input.name}`, actorId });
    this.audit?.write({ level: KernLevel.NOTICE, facility: FACILITY, message: `Security group created — ${input.name}`, actorId, metadata: { eventType: 'secgroup.created' } });
    return sg;
  }

  async list(page = 1, limit = 20, name?: string): Promise<{ items: SecurityGroup[]; total: number; page: number; limit: number }> {
    let all = (await this.#listAll()).reverse();
    if (name) all = all.filter(sg => sg.name.toLowerCase().includes(name.toLowerCase()));
    return { items: all.slice((page - 1) * limit, page * limit), total: all.length, page, limit };
  }

  async get(id: SecurityGroupId): Promise<SecurityGroup | null> {
    const entry = await this.atomic.get<SecurityGroup>(PREFIX + id);
    return entry?.value ?? null;
  }

  async update(id: SecurityGroupId, input: UpdateSecurityGroupInput, actorId?: string): Promise<SecurityGroup> {
    const entry = await this.atomic.get<SecurityGroup>(PREFIX + id);
    if (!entry) throw new AppError(404, 'SECGROUP_NOT_FOUND', 'Security group not found');

    const updated: SecurityGroup = {
      ...entry.value,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description ?? undefined } : {}),
      ...(input.securityGroupId !== undefined ? { securityGroupId: input.securityGroupId ?? undefined } : {}),
      ...(input.rules !== undefined ? { rules: input.rules ?? undefined } : {}),
      ...(input.bandwidth !== undefined ? { bandwidth: input.bandwidth ?? undefined } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      ...(input.userIds !== undefined ? { userIds: input.userIds ?? [] } : {}),
      ...(input.userGroupIds !== undefined ? { userGroupIds: input.userGroupIds ?? [] } : {}),
      ...(input.status !== undefined ? { status: input.status as SecurityGroupStatus } : {}),
      updatedAt: Date.now(),
    };

    const newVersion = await this.atomic.set(PREFIX + id, updated, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');

    if (input.rules !== undefined && updated.providerNetworkId && this.networkPolicy?.applyRules) {
      await this.networkPolicy.applyRules(updated.providerNetworkId, updated.rules ?? []).catch(e => {
        this.logger.write({ facility: FACILITY, level: KernLevel.WARNING, message: `Failed to apply rules: ${e.message}`, actorId });
      });
    }
    return updated;
  }

  async delete(id: SecurityGroupId, actorId?: string): Promise<void> {
    const entry = await this.atomic.get<SecurityGroup>(PREFIX + id);
    if (!entry) throw new AppError(404, 'SECGROUP_NOT_FOUND', 'Security group not found');
    if (entry.value.providerNetworkId && this.networkPolicy) {
      try { await this.networkPolicy.removeNetwork(entry.value.providerNetworkId); } catch { /* best-effort — provider network may already be gone */ }
    }
    await this.atomic.set(PREFIX + id, null, entry.version);
    await this.#removeFromIndex(id);
    this.audit?.write({ level: KernLevel.WARNING, facility: FACILITY, message: `Security group deleted — ${entry.value.name}`, actorId, metadata: { eventType: 'secgroup.deleted' } });
  }

  async #listAll(): Promise<SecurityGroup[]> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    if (!idx) return [];
    const entries = await Promise.all(idx.value.map(id => this.atomic.get<SecurityGroup>(PREFIX + id)));
    return entries.filter(e => e).map(e => e!.value);
  }
  async #addToIndex(id: SecurityGroupId): Promise<void> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    await this.atomic.set(INDEX_KEY, [...(idx?.value ?? []), id], idx?.version ?? null);
  }
  async #removeFromIndex(id: SecurityGroupId): Promise<void> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    if (!idx) return;
    await this.atomic.set(INDEX_KEY, idx.value.filter((i: string) => i !== id), idx.version);
  }
}
