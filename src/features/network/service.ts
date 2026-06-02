import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { ILogWriter } from '../../core/logger/interfaces.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import { createFacility } from '../../core/brand.ts';
import { LogLevel, AppError } from '../../core/types.ts';
import { KernLevel } from '../../core/audit/kern-level.ts';
import { parseCidr } from '../../core/network/cidr.ts';
import type { RegionId } from '../../core/region/types.ts';
import type {
  VirtualNetwork, NetworkId, NetworkStatus,
  CreateNetworkInput, UpdateNetworkInput,
} from './types.ts';
import { generateNetworkId } from './types.ts';

const FACILITY = createFacility('network');
const NETWORK_PREFIX = 'vnet:';
const NETWORK_INDEX_KEY = 'vnet:ids';

export interface INetworkService {
  create(input: CreateNetworkInput, actorId?: string): Promise<VirtualNetwork>;
  list(page?: number, limit?: number, filter?: { visibility?: string | undefined; provider?: string | undefined; region?: string | undefined }, currentUser?: { id: string; role?: string } | undefined): Promise<{ items: VirtualNetwork[]; total: number; page: number; limit: number }>;
  get(id: NetworkId): Promise<VirtualNetwork | null>;
  update(id: NetworkId, input: UpdateNetworkInput, actorId?: string): Promise<VirtualNetwork>;
  delete(id: NetworkId, actorId?: string): Promise<void>;
}

export class NetworkService implements INetworkService {
  constructor(
    private readonly atomic: IAtomicStore,
    private readonly logger: ILogWriter,
    private readonly audit?: IAuditWriter,
  ) {}

  async create(input: CreateNetworkInput, actorId?: string): Promise<VirtualNetwork> {
    try {
      parseCidr(input.cidr);
    } catch {
      throw new AppError(400, 'INVALID_CIDR', `Invalid CIDR: ${input.cidr}`);
    }

    const id = generateNetworkId();
    const now = Date.now();

    const network: VirtualNetwork = {
      id,
      name: input.name,
      description: input.description,
      cidr: input.cidr,
      subnetPrefix: input.subnetPrefix,
      securityGroupId: input.securityGroupId,
      provider: input.provider,
      region: input.region as RegionId,
      visibility: input.visibility ?? 'private',
      creatorId: actorId,
      userIds: input.userIds ?? [],
      userGroupIds: input.userGroupIds ?? [],
      status: 'Active',
      createdAt: now,
      updatedAt: now,
    };

    await this.atomic.set(NETWORK_PREFIX + id, network, null);
    await this.#addToIndex(id);
    await this.#incrCounter().catch(() => {});

    await this.logger.logAsync({
      facility: FACILITY, level: LogLevel.INFO,
      message: `Virtual network created: ${input.name} (${input.cidr})`,
      metadata: { networkId: id, actorId },
    });

    this.audit?.write({
      level: KernLevel.NOTICE, facility: FACILITY,
      message: `Virtual network created — ${input.name} (${input.cidr})`,
      metadata: { eventType: 'network.created', networkId: id, actorId },
    });

    return network;
  }

  async list(
    page = 1, limit = 20,
    filter?: { visibility?: string | undefined; provider?: string | undefined; region?: string | undefined },
    currentUser?: { id: string; role?: string } | undefined,
  ): Promise<{ items: VirtualNetwork[]; total: number; page: number; limit: number }> {
    const all = await this.#listAll();
    const accessResults = await Promise.all(all.map(n => this.#canAccess(n, currentUser)));
    let filtered = all.filter((_, i) => accessResults[i]);

    if (filter?.visibility) filtered = filtered.filter(n => n.visibility === filter.visibility);
    if (filter?.provider) filtered = filtered.filter(n => n.provider === filter.provider);
    if (filter?.region) filtered = filtered.filter(n => n.region === filter.region);

    const total = filtered.length;
    const start = (page - 1) * limit;
    const items = filtered.slice(start, start + limit);

    return { items, total, page, limit };
  }

  async get(id: NetworkId): Promise<VirtualNetwork | null> {
    const entry = await this.atomic.get<VirtualNetwork>(NETWORK_PREFIX + id);
    return entry?.value ?? null;
  }

  async update(id: NetworkId, input: UpdateNetworkInput, actorId?: string): Promise<VirtualNetwork> {
    const entry = await this.atomic.get<VirtualNetwork>(NETWORK_PREFIX + id);
    if (!entry) throw new AppError(404, 'NETWORK_NOT_FOUND', 'Virtual network not found');

    const updated: VirtualNetwork = {
      ...entry.value,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description ?? undefined } : {}),
      ...(input.securityGroupId !== undefined ? { securityGroupId: input.securityGroupId ?? undefined } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      ...(input.userIds !== undefined ? { userIds: input.userIds ?? [] } : {}),
      ...(input.userGroupIds !== undefined ? { userGroupIds: input.userGroupIds ?? [] } : {}),
      ...(input.status !== undefined ? { status: input.status as NetworkStatus } : {}),
      updatedAt: Date.now(),
    };

    const newVersion = await this.atomic.set(NETWORK_PREFIX + id, updated, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');

    this.audit?.write({
      level: KernLevel.NOTICE, facility: FACILITY,
      message: `Virtual network updated — ${updated.name}`,
      metadata: { eventType: 'network.updated', networkId: id, actorId },
    });

    return updated;
  }

  async delete(id: NetworkId, actorId?: string): Promise<void> {
    const entry = await this.atomic.get<VirtualNetwork>(NETWORK_PREFIX + id);
    if (!entry) throw new AppError(404, 'NETWORK_NOT_FOUND', 'Virtual network not found');

    await this.atomic.set(NETWORK_PREFIX + id, null, entry.version);
    await this.#removeFromIndex(id);
    await this.#decrCounter().catch(() => {});

    this.audit?.write({
      level: KernLevel.WARNING, facility: FACILITY,
      message: `Virtual network deleted — ${entry.value.name} (${entry.value.cidr})`,
      metadata: { eventType: 'network.deleted', networkId: id, actorId },
    });
  }

  // ─── Visibility / Access control ───

  /**
   * 可见性规则：
   *   1. >= root 组且 role='root' → 无视规则，全部可见
   *   2. public → 所有人可见
   *   3. private → 创建者本人 / userIds 白名单 / userGroupIds 白名单
   */
  async #canAccess(network: VirtualNetwork, user: { id: string; role?: string } | undefined): Promise<boolean> {
    // 未认证用户只能看到 public
    if (!user) return network.visibility === 'public';

    // Root 组 + role='root' 绕过所有限制
    if (await this.#isRootUser(user.id, user.role)) return true;

    // Public → 所有认证用户
    if (network.visibility === 'public') return true;

    // Private → 检查白名单
    if (network.creatorId === user.id) return true;
    if (network.userIds?.includes(user.id)) return true;
    if (network.userGroupIds?.length) {
      const userGroupIds = await this.#getUserGroupIds(user.id);
      if (network.userGroupIds.some(gid => userGroupIds.includes(gid))) return true;
    }

    return false;
  }

  /** 检查用户是否 >= root 组且 role='root' */
  async #isRootUser(userId: string, userRole?: string): Promise<boolean> {
    if (userRole !== 'root') return false;
    const ugEntry = await this.atomic.get<string[]>('usergroup:ids');
    if (!ugEntry) return false;
    for (const gid of ugEntry.value) {
      const g = await this.atomic.get<any>('usergroup:' + gid);
      if (g?.value?.name === 'root' && g.value.memberIds?.includes(userId)) {
        return true;
      }
    }
    return false;
  }

  /** 获取用户所在的所有用户组 ID */
  async #getUserGroupIds(userId: string): Promise<string[]> {
    const results: string[] = [];
    const ugEntry = await this.atomic.get<string[]>('usergroup:ids');
    if (!ugEntry) return results;
    for (const gid of ugEntry.value) {
      const g = await this.atomic.get<any>('usergroup:' + gid);
      if (g?.value?.memberIds?.includes(userId)) {
        results.push(gid);
      }
    }
    return results;
  }

  // ─── Internal helpers ───

  async #listAll(): Promise<VirtualNetwork[]> {
    const idx = await this.atomic.get<string[]>(NETWORK_INDEX_KEY);
    if (!idx) return [];
    const entries = await Promise.all(idx.value.map(id => this.atomic.get<VirtualNetwork>(NETWORK_PREFIX + id)));
    return entries.filter(e => e).map(e => e!.value);
  }

  async #addToIndex(id: NetworkId): Promise<void> {
    const idx = await this.atomic.get<string[]>(NETWORK_INDEX_KEY);
    await this.atomic.set(NETWORK_INDEX_KEY, [...(idx?.value ?? []), id], idx?.version ?? null);
  }

  async #removeFromIndex(id: NetworkId): Promise<void> {
    const idx = await this.atomic.get<string[]>(NETWORK_INDEX_KEY);
    if (!idx) return;
    await this.atomic.set(NETWORK_INDEX_KEY, idx.value.filter((i: string) => i !== id), idx.version);
  }

  async #incrCounter(): Promise<void> {
    const entry = await this.atomic.get<number>('vnet:count');
    await this.atomic.set('vnet:count', (entry?.value ?? 0) + 1, entry?.version ?? null);
  }

  async #decrCounter(): Promise<void> {
    const entry = await this.atomic.get<number>('vnet:count');
    if (!entry || entry.value <= 0) return;
    await this.atomic.set('vnet:count', entry.value - 1, entry.version);
  }
}
