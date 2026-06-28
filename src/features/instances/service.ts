/**
 * Compute instance service — GitHub Runner model.
 *
 * Manages runner lifecycle: registration → online → heartbeat → offline → deleted.
 * busy flag is independent of status (busy=true ⇒ status=online is invariant).
 */

import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { ILogWriter, IAuditWriter } from '../../core/audit/types.ts';
import { createFacility } from '../../core/brand.ts';
import { AppError } from '../../core/types.ts';
import { KernLevel } from '../../core/audit/kern-level.ts';
import type {
  RunnerInstance, RunnerGroup, RunnerId, RunnerGroupId,
  CreateRunnerInput, UpdateRunnerInput, CreateRunnerGroupInput,
  RegistrationToken,
} from './types.ts';
import { generateRunnerId, generateRunnerGroupId } from './types.ts';

const FACILITY = createFacility('instances');

const RUNNER_PREFIX = 'runner:';
const RUNNER_IDS_KEY = 'runner:ids';
const RUNNER_GROUP_PREFIX = 'runner:group:';
const RUNNER_GROUP_IDS_KEY = 'runner:group:ids';
const REG_TOKEN_PREFIX = 'runner:regtoken:';

// Registration token TTL: 1 hour (GitHub model)
const REG_TOKEN_TTL_MS = 3_600_000;

// Heartbeat timeout: 5 minutes without heartbeat → offline
const HEARTBEAT_TIMEOUT_MS = 5 * 60_000;

export interface IRunnerService {
  // Runner CRUD
  register(input: CreateRunnerInput): Promise<{ runner: RunnerInstance; token: RegistrationToken }>;
  get(id: RunnerId): Promise<RunnerInstance | null>;
  list(status?: string): Promise<RunnerInstance[]>;
  update(id: RunnerId, input: UpdateRunnerInput, actorId?: string): Promise<RunnerInstance>;
  delete(id: RunnerId, actorId?: string): Promise<void>;

  // Heartbeat
  heartbeat(id: RunnerId): Promise<RunnerInstance>;
  /** Mark stale runners (>5 min no heartbeat) as offline. Returns count of runners marked offline. */
  markStaleOffline(): Promise<number>;

  // Runner groups
  createGroup(input: CreateRunnerGroupInput, actorId?: string): Promise<RunnerGroup>;
  getGroup(id: RunnerGroupId): Promise<RunnerGroup | null>;
  listGroups(): Promise<RunnerGroup[]>;
  deleteGroup(id: RunnerGroupId, actorId?: string): Promise<void>;

  // Registration tokens
  createRegistrationToken(): Promise<RegistrationToken>;
  validateRegistrationToken(token: string): Promise<boolean>;
}

export class RunnerService implements IRunnerService {
  constructor(
    private readonly atomic: IAtomicStore,
    private readonly logger: ILogWriter,
    private readonly audit?: IAuditWriter,
  ) {}

  // ─── Runner CRUD ───

  async register(input: CreateRunnerInput): Promise<{ runner: RunnerInstance; token: RegistrationToken }> {
    const id = generateRunnerId();
    const now = Date.now();
    const runner: RunnerInstance = {
      id,
      name: input.name,
      os: input.os ?? 'linux',
      status: 'online',
      busy: false,
      labels: input.labels ?? [],
      providerInstanceId: input.providerInstanceId,
      groupIds: input.groupIds ?? [],
      registeredAt: now,
      lastHeartbeatAt: now,
    };

    await this.atomic.set(RUNNER_PREFIX + id, runner, null);
    await this.#addRunnerToIndex(id);

    const token = await this.createRegistrationToken();

    await this.logger.write({
      facility: FACILITY, level: KernLevel.INFO,
      message: `Runner registered: ${input.name}`,
      metadata: { runnerId: id, os: runner.os },
    });

    await this.audit?.write({
      level: KernLevel.NOTICE, facility: FACILITY,
      message: `Runner registered — ${input.name} (id=${id as string})`,
      metadata: { eventType: 'runner.registered', runnerId: id },
    });

    return { runner, token };
  }

  async get(id: RunnerId): Promise<RunnerInstance | null> {
    const entry = await this.atomic.get<RunnerInstance>(RUNNER_PREFIX + id);
    return entry?.value ?? null;
  }

  async list(status?: string): Promise<RunnerInstance[]> {
    const idx = await this.atomic.get<string[]>(RUNNER_IDS_KEY);
    if (!idx) return [];
    const entries = await Promise.all(
      idx.value.map(id => this.atomic.get<RunnerInstance>(RUNNER_PREFIX + id)),
    );
    let runners = entries.filter(e => e).map(e => e!.value);
    if (status) runners = runners.filter(r => r.status === status);
    return runners;
  }

  async update(id: RunnerId, input: UpdateRunnerInput, _actorId?: string): Promise<RunnerInstance> {
    const entry = await this.atomic.get<RunnerInstance>(RUNNER_PREFIX + id);
    if (!entry) throw new AppError(404, 'RUNNER_NOT_FOUND', 'Runner not found');

    const updated: RunnerInstance = {
      ...entry.value,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.labels !== undefined ? { labels: input.labels } : {}),
      ...(input.groupIds !== undefined ? { groupIds: input.groupIds } : {}),
    };
    const ver = await this.atomic.set(RUNNER_PREFIX + id, updated, entry.version);
    if (!ver) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');
    return updated;
  }

  async delete(id: RunnerId, _actorId?: string): Promise<void> {
    const entry = await this.atomic.get<RunnerInstance>(RUNNER_PREFIX + id);
    if (!entry) throw new AppError(404, 'RUNNER_NOT_FOUND', 'Runner not found');
    await this.atomic.set(RUNNER_PREFIX + id, null, entry.version);
    await this.#removeRunnerFromIndex(id);

    await this.audit?.write({
      level: KernLevel.WARNING, facility: FACILITY,
      message: `Runner deleted — ${entry.value.name}`,
      metadata: { eventType: 'runner.deleted', runnerId: id },
    });
  }

  // ─── Heartbeat ───

  async heartbeat(id: RunnerId): Promise<RunnerInstance> {
    const entry = await this.atomic.get<RunnerInstance>(RUNNER_PREFIX + id);
    if (!entry) throw new AppError(404, 'RUNNER_NOT_FOUND', 'Runner not found');

    const updated: RunnerInstance = {
      ...entry.value,
      status: 'online',
      lastHeartbeatAt: Date.now(),
    };
    await this.atomic.set(RUNNER_PREFIX + id, updated, entry.version);
    return updated;
  }

  async markStaleOffline(): Promise<number> {
    const threshold = Date.now() - HEARTBEAT_TIMEOUT_MS;
    const runners = await this.list('online');
    let count = 0;
    for (const r of runners) {
      if (r.lastHeartbeatAt < threshold) {
        const entry = await this.atomic.get<RunnerInstance>(RUNNER_PREFIX + (r.id as string));
        if (!entry) continue;
        const updated: RunnerInstance = { ...entry.value, status: 'offline' };
        await this.atomic.set(RUNNER_PREFIX + (r.id as string), updated, entry.version);
        count++;
      }
    }
    if (count > 0) {
      await this.logger.write({
        facility: FACILITY, level: KernLevel.WARNING,
        message: `Marked ${count} runners offline (stale heartbeat)`,
      });
    }
    return count;
  }

  // ─── Runner groups ───

  async createGroup(input: CreateRunnerGroupInput, _actorId?: string): Promise<RunnerGroup> {
    const id = generateRunnerGroupId();
    const now = Date.now();
    const group: RunnerGroup = {
      id, name: input.name,
      visibility: input.visibility ?? 'all',
      selectedScopeIds: input.selectedScopeIds ?? [],
      dependsOn: input.dependsOn ?? [],
      createdAt: now, updatedAt: now,
    };
    await this.atomic.set(RUNNER_GROUP_PREFIX + id, group, null);
    await this.#addGroupToIndex(id);
    return group;
  }

  async getGroup(id: RunnerGroupId): Promise<RunnerGroup | null> {
    const entry = await this.atomic.get<RunnerGroup>(RUNNER_GROUP_PREFIX + id);
    return entry?.value ?? null;
  }

  async listGroups(): Promise<RunnerGroup[]> {
    const idx = await this.atomic.get<string[]>(RUNNER_GROUP_IDS_KEY);
    if (!idx) return [];
    const entries = await Promise.all(
      idx.value.map(id => this.atomic.get<RunnerGroup>(RUNNER_GROUP_PREFIX + id)),
    );
    return entries.filter(e => e).map(e => e!.value);
  }

  async deleteGroup(id: RunnerGroupId, _actorId?: string): Promise<void> {
    const entry = await this.atomic.get<RunnerGroup>(RUNNER_GROUP_PREFIX + id);
    if (!entry) throw new AppError(404, 'RUNNER_GROUP_NOT_FOUND', 'Runner group not found');
    await this.atomic.set(RUNNER_GROUP_PREFIX + id, null, entry.version);
    await this.#removeGroupFromIndex(id);
  }

  // ─── Registration tokens ───

  async createRegistrationToken(): Promise<RegistrationToken> {
    const token: RegistrationToken = {
      token: `rtok_${crypto.randomUUID()}`,
      expiresAt: Date.now() + REG_TOKEN_TTL_MS,
      createdAt: Date.now(),
    };
    await this.atomic.set(REG_TOKEN_PREFIX + token.token, token, null);
    return token;
  }

  async validateRegistrationToken(tok: string): Promise<boolean> {
    const entry = await this.atomic.get<RegistrationToken>(REG_TOKEN_PREFIX + tok);
    if (!entry) return false;
    if (Date.now() >= entry.value.expiresAt) {
      await this.atomic.set(REG_TOKEN_PREFIX + tok, null, entry.version);
      return false;
    }
    // Consume token on validation (one-time use)
    await this.atomic.set(REG_TOKEN_PREFIX + tok, null, entry.version);
    return true;
  }

  // ─── Index helpers ───

  async #addRunnerToIndex(id: string): Promise<void> {
    const idx = await this.atomic.get<string[]>(RUNNER_IDS_KEY);
    await this.atomic.set(RUNNER_IDS_KEY, [...(idx?.value ?? []), id], idx?.version ?? null);
  }

  async #removeRunnerFromIndex(id: string): Promise<void> {
    const idx = await this.atomic.get<string[]>(RUNNER_IDS_KEY);
    if (!idx) return;
    await this.atomic.set(RUNNER_IDS_KEY, idx.value.filter(i => i !== id), idx.version);
  }

  async #addGroupToIndex(id: string): Promise<void> {
    const idx = await this.atomic.get<string[]>(RUNNER_GROUP_IDS_KEY);
    await this.atomic.set(RUNNER_GROUP_IDS_KEY, [...(idx?.value ?? []), id], idx?.version ?? null);
  }

  async #removeGroupFromIndex(id: string): Promise<void> {
    const idx = await this.atomic.get<string[]>(RUNNER_GROUP_IDS_KEY);
    if (!idx) return;
    await this.atomic.set(RUNNER_GROUP_IDS_KEY, idx.value.filter(i => i !== id), idx.version);
  }
}
