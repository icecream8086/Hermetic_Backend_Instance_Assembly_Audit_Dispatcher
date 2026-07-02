import type { IAtomicStore } from '../store/interfaces.ts';
import type { IAuditWriter } from '../audit/types.ts';
import { KernLevel } from '../audit/kern-level.ts';
import { AppError } from '../types.ts';

/** Quota key prefix per user. */
const QUOTA_KEY = 'quota:user:';

export interface UserQuota {
  /** Max number of sandboxes (0 = unlimited). */
  readonly maxSandboxes?: number;
  /** Max total CPU across all sandboxes (0 = unlimited). */
  readonly maxCpu?: number;
  /** Max total memory in MB (0 = unlimited). */
  readonly maxMemory?: number;
}

export interface QuotaUsage {
  readonly sandboxes: number;
  readonly cpu: number;
  readonly memory: number;
}

/**
 * Lightweight user quota enforcement.
 *
 * Quotas are configurable per user via atomic store key `quota:user:<userId>`.
 * If no quota entry exists, no limits are enforced (unlimited).
 * Usage counters are tracked via OCC in the same key.
 */
export class QuotaService {
  public constructor(
    private readonly atomic: IAtomicStore,
    private readonly audit?: IAuditWriter,
  ) {}

  public async getQuota(userId: string): Promise<UserQuota> {
    const entry = await this.atomic.get<UserQuota>(QUOTA_KEY + userId);
    return entry?.value ?? {};
  }

  public async getUsage(userId: string): Promise<QuotaUsage> {
    const entry = await this.atomic.get<QuotaUsage>(`${QUOTA_KEY}${userId}:usage`);
    return entry?.value ?? { sandboxes: 0, cpu: 0, memory: 0 };
  }

  public async setQuota(userId: string, quota: UserQuota): Promise<void> {
    const entry = await this.atomic.get<UserQuota>(QUOTA_KEY + userId);
    await this.atomic.set(QUOTA_KEY + userId, quota, entry?.version ?? null);
    this.audit?.write({
      level: KernLevel.NOTICE,
      facility: 'quota',
      message: `Quota set for user ${userId}`,
      metadata: { eventType: 'quota.set', userId, quota },
    });
  }

  /**
   * Check if a user has capacity to create a sandbox with the given resources.
   * Throws an error with `status` property if quota would be exceeded.
   */
  public async checkQuota(userId: string, cpu: number, memory: number): Promise<void> {
    const quota = await this.getQuota(userId);
    if (!quota.maxSandboxes && !quota.maxCpu && !quota.maxMemory) return; // unlimited

    const usage = await this.getUsage(userId);

    if (quota.maxSandboxes && usage.sandboxes >= quota.maxSandboxes) {
      throw new AppError(429, 'RATE_LIMITED', `Sandbox quota exceeded: ${String(usage.sandboxes)}/${String(quota.maxSandboxes)}`);
    }
    if (quota.maxCpu && (usage.cpu + cpu) > quota.maxCpu) {
      throw new AppError(429, 'RATE_LIMITED', `CPU quota exceeded: ${String(usage.cpu + cpu)}/${String(quota.maxCpu)}`);
    }
    if (quota.maxMemory && (usage.memory + memory) > quota.maxMemory) {
      throw new AppError(429, 'RATE_LIMITED', `Memory quota exceeded: ${String(usage.memory + memory)}/${String(quota.maxMemory)}`);
    }
  }

  /**
   * Record a sandbox creation (increment counters).
   */
  public async recordCreate(userId: string, cpu: number, memory: number): Promise<void> {
    const key = `${QUOTA_KEY}${userId}:usage`;
    const entry = await this.atomic.get<QuotaUsage>(key);
    const current = entry?.value ?? { sandboxes: 0, cpu: 0, memory: 0 };
    await this.atomic.set(key, {
      sandboxes: current.sandboxes + 1,
      cpu: current.cpu + cpu,
      memory: current.memory + memory,
    }, entry?.version ?? null);
  }

  /**
   * Record a sandbox deletion (decrement counters).
   */
  public async recordDelete(userId: string, cpu: number, memory: number): Promise<void> {
    const key = `${QUOTA_KEY}${userId}:usage`;
    const entry = await this.atomic.get<QuotaUsage>(key);
    if (!entry) return;
    const current = entry.value;
    await this.atomic.set(key, {
      sandboxes: Math.max(0, current.sandboxes - 1),
      cpu: Math.max(0, current.cpu - cpu),
      memory: Math.max(0, current.memory - memory),
    }, entry.version);
  }
}
