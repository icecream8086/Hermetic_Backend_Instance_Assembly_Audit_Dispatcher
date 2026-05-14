import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { ILogWriter } from '../../core/logger/interfaces.ts';
import type {
  IContainerProvider,
  IDnsProvider,
  IMetricsProvider,
} from '../../core/provider/interfaces.ts';
import {
  SandboxStatus,
  isValidTransition,
  createSandboxId,
  createDnsRecordId,
  DnsRecordStatus,
} from './types.ts';
import type {
  SandboxId,
  Sandbox,
  CreateSandboxInput,
  DnsRecord,
  MetricSnapshot,
  NetworkInfo,
  ContainerRuntime,
  ContainerEvent,
} from './types.ts';
import type {
  ISandboxService,
  ISandboxDnsService,
  ISandboxMetricsService,
  ISandboxLogService,
  LogQueryOptions,
  MetricTimeRange,
} from './interfaces.ts';
import type { ContainerLogResult } from '../../core/provider/interfaces.ts';
import { LogLevel } from '../../core/types.ts';
import { createFacility, generateVersionId } from '../../core/brand.ts';
import { AppError } from '../../core/types.ts';

const FACILITY = createFacility('sandbox-service');
const KEY_PREFIX = 'sandbox:';

// ─── Service ───

export class SandboxService implements ISandboxService {
  constructor(
    private readonly atomic: IAtomicStore,
    private readonly logger: ILogWriter,
    private readonly containerProvider: IContainerProvider,
  ) {}

  async provision(input: CreateSandboxInput, idempotencyKey?: string): Promise<Sandbox> {
    if (idempotencyKey) {
      const existing = await this.atomic.get<Sandbox>(`${KEY_PREFIX}idem:${idempotencyKey}`);
      if (existing) return existing.value;
    }

    // 1. Create the cloud resource
    const { providerId } = await this.containerProvider.create(input);

    // 2. Build the sandbox entity
    const id = createSandboxId(providerId);
    const sandbox = {
      id,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      tags: input.tags ?? [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: SandboxStatus.Running,
      version: generateVersionId(),
      config: input,
      providerId,
      network: {} as NetworkInfo,
      containers: [] as ContainerRuntime[],
      events: [] as ContainerEvent[],
    } as Sandbox;

    // 3. Persist
    const persisted = await this.atomic.set<Sandbox>(
      `${KEY_PREFIX}${id}`,
      sandbox,
      null,
    );

    if (persisted && idempotencyKey) {
      await this.atomic.set(`${KEY_PREFIX}idem:${idempotencyKey}`, sandbox, null);
    }

    await this.logger.logAsync({
      facility: FACILITY,
      level: LogLevel.INFO,
      message: 'Sandbox provisioned',
      metadata: { sandboxId: id as string, providerId, name: input.name },
    });

    return sandbox;
  }

  async getById(id: SandboxId): Promise<Sandbox | null> {
    const entry = await this.atomic.get<Sandbox>(`${KEY_PREFIX}${id}`);
    return entry?.value ?? null;
  }

  async stop(id: SandboxId): Promise<Sandbox> {
    return this.transition(id, SandboxStatus.Stopped, 'user requested stop');
  }

  async terminate(id: SandboxId): Promise<void> {
    const sandbox = await this.getById(id);
    if (!sandbox) throw new AppError(404, 'SANDBOX_NOT_FOUND', `Sandbox ${id} not found`);

    await this.containerProvider.delete({
      region: sandbox.config.region,
      providerId: sandbox.providerId ?? String(id),
    });

    await this.transition(id, SandboxStatus.Deleted, 'user requested termination');

    await this.logger.logAsync({
      facility: FACILITY,
      level: LogLevel.INFO,
      message: 'Sandbox terminated',
      metadata: { sandboxId: id as string },
    });
  }

  async forceTransition(id: SandboxId, to: SandboxStatus, reason: string): Promise<Sandbox> {
    return this.transition(id, to, reason);
  }

  private async transition(id: SandboxId, to: SandboxStatus, reason: string): Promise<Sandbox> {
    const entry = await this.atomic.get<Sandbox>(`${KEY_PREFIX}${id}`);
    if (!entry) throw new AppError(404, 'SANDBOX_NOT_FOUND', `Sandbox ${id} not found`);

    const from = entry.value;
    if (!isValidTransition(from.status, to)) {
      throw new AppError(409, 'INVALID_TRANSITION', `Cannot transition from ${from.status} to ${to}`);
    }

    const updated: Sandbox = {
      ...from,
      status: to,
      updatedAt: Date.now(),
      version: generateVersionId(),
    };

    const newVersion = await this.atomic.set(`${KEY_PREFIX}${id}`, updated, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');

    await this.logger.logAsync({
      facility: FACILITY,
      level: LogLevel.INFO,
      message: `Sandbox ${from.status} → ${to}`,
      metadata: { sandboxId: id as string, fromStatus: from.status, toStatus: to, reason },
    });

    return updated;
  }
}

// ─── DNS service ───

export class SandboxDnsService implements ISandboxDnsService {
  constructor(
    private readonly atomic: IAtomicStore,
    private readonly dnsProvider: IDnsProvider,
    private readonly logger: ILogWriter,
    private readonly zoneId: string = 'stub-zone',
  ) {}

  async pollForIp(sandboxId: SandboxId, timeoutMs: number, pollIntervalMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const entry = await this.atomic.get<Sandbox>(`${KEY_PREFIX}${sandboxId}`);
      if (entry?.value.network.publicIp) {
        return entry.value.network.publicIp;
      }
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }

    return null;
  }

  async syncDns(sandboxId: SandboxId): Promise<void> {
    const entry = await this.atomic.get<Sandbox>(`${KEY_PREFIX}${sandboxId}`);
    if (!entry) throw new AppError(404, 'SANDBOX_NOT_FOUND', `Sandbox ${sandboxId} not found`);
    if (!entry.value.network.publicIp) throw new AppError(400, 'NO_PUBLIC_IP', 'Sandbox has no public IP');

    const record = {
      id: createDnsRecordId(`dns-${sandboxId as string}`),
      name: `dns-${sandboxId as string}`,
      tags: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: DnsRecordStatus.Active,
      domain: `${sandboxId as string}.example.com`,
      type: 'A' as const,
      value: entry.value.network.publicIp,
      ttl: 60,
      proxied: false,
      sandboxId,
    } as DnsRecord;

    await this.dnsProvider.updateRecord({
      domain: record.domain,
      type: record.type,
      value: record.value,
      ttl: record.ttl,
      proxied: record.proxied,
      providerRecordId: `dns-${sandboxId as string}`,
      zoneId: this.zoneId,
    });

    await this.logger.logAsync({
      facility: FACILITY,
      level: LogLevel.INFO,
      message: 'DNS record synced',
      metadata: { sandboxId: sandboxId as string, ip: entry.value.network.publicIp },
    });
  }

  async cleanupDns(sandboxId: SandboxId): Promise<void> {
    await this.dnsProvider.deleteRecord({
      zoneId: this.zoneId,
      providerRecordId: `dns-${sandboxId as string}`,
    });
  }
}

// ─── Metrics service ───

export class SandboxMetricsService implements ISandboxMetricsService {
  constructor(
    private readonly metricsProvider: IMetricsProvider,
    /** Region passed through to the provider. Resolved from the sandbox's config at call sites. */
    private readonly defaultRegion: string = 'unknown',
  ) {}

  async collect(sandboxId: SandboxId): Promise<readonly MetricSnapshot[]> {
    // TODO: resolve region from the sandbox entity
    const result = await this.metricsProvider.fetchMetrics({
      region: this.defaultRegion,
      providerId: String(sandboxId),
    });
    return result.snapshots;
  }

  // TODO: implement query against IQueryStore once D1 / FileQuery is wired
  async query(_sandboxId: SandboxId, _range: MetricTimeRange): Promise<readonly MetricSnapshot[]> {
    throw new AppError(501, 'NOT_IMPLEMENTED', 'MetricSnapshot query is not yet implemented');
  }
}

// ─── Log service ───

export class SandboxLogService implements ISandboxLogService {
  constructor(
    private readonly containerProvider: IContainerProvider,
    /** Default region passed through to the provider. */
    private readonly defaultRegion: string = 'unknown',
  ) {}

  async getLogs(
    sandboxId: SandboxId,
    containerName: string,
    options?: LogQueryOptions,
  ): Promise<ContainerLogResult> {
    return this.containerProvider.getLogs({
      region: this.defaultRegion,
      providerId: String(sandboxId),
      containerName,
      ...(options?.limitBytes !== undefined ? { limitBytes: options.limitBytes } : {}),
      ...(options?.sinceSeconds !== undefined ? { sinceSeconds: options.sinceSeconds } : {}),
      ...(options?.timestamps !== undefined ? { timestamps: options.timestamps } : {}),
    });
  }
}
