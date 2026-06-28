import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import { AppError } from '../../core/types.ts';
import { generateVersionId } from '../../core/brand.ts';
import type { VersionId } from '../../core/brand.ts';
import type { ResourceNode } from '../../core/scheduler/dag/types.ts';

const PFX = 'action-runner:';
const IDX = 'action-runner:ids';
/** Heartbeat timeout: runners not seen within this window are marked offline. */
const HEARTBEAT_TIMEOUT_MS = 30_000;

export interface RunnerRegistration {
  readonly id: string;
  readonly name: string;
  /** Backing compute instance ID. Maps to IProviderRegistry.resolveContainer(). */
  readonly instanceId?: string;
  /** Labels for job matching (runs-on). e.g. { os: "linux", arch: "amd64" }. */
  readonly labels: Readonly<Record<string, string>>;
  /** Total resource capacity of this runner. */
  readonly capacity: {
    readonly cpu: number;
    readonly memory: number;   // MB
    readonly gpu?: number;
  };
  /** Current status. */
  readonly status: 'online' | 'offline' | 'draining';
  /** Version of the runner software. */
  readonly version: string;
  /** Last heartbeat timestamp (unix ms). */
  readonly lastHeartbeat: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly storeVersion: VersionId;
}

/** Input for registration or heartbeat update. */
export interface RunnerHeartbeatInput {
  readonly name: string;
  readonly instanceId?: string;
  readonly labels: Record<string, string>;
  readonly capacity: { cpu: number; memory: number; gpu?: number };
  readonly version?: string;
}

/**
 * Runner Registry — manages runner lifecycle.
 *
 * Extensibility: pluggable health policies (graceful drain, auto-scale signals,
 * custom health checks) can be added via IHealthPolicy interface without
 * modifying this class.
 */
export class RunnerRegistry {
  constructor(
    private readonly atomic: IAtomicStore,
    private readonly audit: IAuditWriter,
  ) {}

  /** Register a new runner or update heartbeat for an existing one. */
  async heartbeat(input: RunnerHeartbeatInput): Promise<RunnerRegistration> {
    // Find existing runner by name
    const existing = await this.#findByName(input.name);

    if (existing) {
      const updated: RunnerRegistration = {
        ...existing,
        ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        labels: input.labels,
        capacity: input.capacity,
        status: 'online',
        version: input.version ?? existing.version,
        lastHeartbeat: Date.now(),
        updatedAt: Date.now(),
        storeVersion: generateVersionId(),
      };
      const ver = await this.atomic.set(PFX + existing.id, updated, existing.storeVersion);
      if (!ver) throw new AppError(409, 'CONFLICT', 'Concurrent heartbeat update');
      return updated;
    }

    // New runner
    const id = `runner_${crypto.randomUUID()}`;
    const now = Date.now();
    const runner: RunnerRegistration = {
      id, name: input.name,
      ...(input.instanceId ? { instanceId: input.instanceId } : {}),
      labels: input.labels,
      capacity: input.capacity,
      status: 'online',
      version: input.version ?? '1.0.0',
      lastHeartbeat: now,
      createdAt: now, updatedAt: now,
      storeVersion: generateVersionId(),
    };

    await this.atomic.set(PFX + id, runner, null);
    const idx = await this.atomic.get<string[]>(IDX);
    await this.atomic.set(IDX, [...(idx?.value ?? []), id], idx?.version ?? null);

    this.audit.write({
      level: 5, facility: 'runner-registry',
      message: `Runner registered: ${input.name} (${id})`,
      metadata: { runnerId: id, labels: input.labels },
    });

    return runner;
  }

  /** Mark runners that haven't sent a heartbeat recently as offline. */
  async markStale(): Promise<number> {
    const idx = await this.atomic.get<string[]>(IDX);
    if (!idx) return 0;
    const now = Date.now();
    let marked = 0;

    for (const id of idx.value) {
      const entry = await this.atomic.get<RunnerRegistration>(PFX + id);
      if (entry?.value.status !== 'online') continue;
      if (now - entry.value.lastHeartbeat < HEARTBEAT_TIMEOUT_MS) continue;

      const updated: RunnerRegistration = {
        ...entry.value,
        status: 'offline',
        updatedAt: now,
        storeVersion: generateVersionId(),
      };
      const ver = await this.atomic.set(PFX + id, updated, entry.version);
      if (ver) marked++;
    }
    return marked;
  }

  /** List online runners, optionally filtered by label requirements. */
  async listOnline(requiredLabels?: Record<string, string>): Promise<RunnerRegistration[]> {
    const idx = await this.atomic.get<string[]>(IDX);
    if (!idx) return [];

    const entries = await Promise.all(
      idx.value.map(i => this.atomic.get<RunnerRegistration>(PFX + i)),
    );
    let runners = entries.filter(e => e?.value.status === 'online').map(e => e!.value);

    if (requiredLabels) {
      runners = runners.filter(r =>
        Object.entries(requiredLabels).every(([k, v]) => r.labels[k] === v),
      );
    }

    return runners;
  }

  /** Convert online runners to ResourceNode[] for the DagScheduler. */
  async toResourceNodes(requiredLabels?: Record<string, string>): Promise<ResourceNode[]> {
    const runners = await this.listOnline(requiredLabels);
    return runners.map(r => ({
      id: r.id,
      capacity: r.capacity,
      labels: r.labels,
    }));
  }

  /** Set a runner to draining (stop accepting new jobs). */
  async drain(id: string): Promise<void> {
    const entry = await this.atomic.get<RunnerRegistration>(PFX + id);
    if (!entry) throw new AppError(404, 'RUNNER_NOT_FOUND', 'Runner not found');
    const updated: RunnerRegistration = {
      ...entry.value, status: 'draining', updatedAt: Date.now(), storeVersion: generateVersionId(),
    };
    await this.atomic.set(PFX + id, updated, entry.version);
  }

  async get(id: string): Promise<RunnerRegistration | null> {
    const entry = await this.atomic.get<RunnerRegistration>(PFX + id);
    return entry?.value ?? null;
  }

  async list(): Promise<RunnerRegistration[]> {
    const idx = await this.atomic.get<string[]>(IDX);
    if (!idx) return [];
    const entries = await Promise.all(
      idx.value.map(i => this.atomic.get<RunnerRegistration>(PFX + i)),
    );
    return entries.filter(e => e).map(e => e!.value);
  }

  async #findByName(name: string): Promise<RunnerRegistration | null> {
    const idx = await this.atomic.get<string[]>(IDX);
    if (!idx) return null;
    for (const id of idx.value) {
      const entry = await this.atomic.get<RunnerRegistration>(PFX + id);
      if (entry?.value.name === name) return entry.value;
    }
    return null;
  }
}
