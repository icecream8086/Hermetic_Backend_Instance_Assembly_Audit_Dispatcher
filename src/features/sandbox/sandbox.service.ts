import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { ILogWriter } from '../../core/logger/interfaces.ts';
import type {
  IContainerProvider,
  IMetricsProvider,
  MetricSnapshot,
  ContainerGroupRuntime,
  OciContainerStatus,
  CreateContainerGroupInput,
} from '../../core/provider/index.ts';
import {
  SandboxStatus,
  isValidTransition,
  createSandboxId,
} from './types.ts';
import type {
  SandboxId,
  Sandbox,
  CreateSandboxInput,
  NetworkInfo,
  ContainerRuntime,
  ContainerEvent,
} from './types.ts';
import type {
  ISandboxService,
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

    // 1. Generate sandbox identity and persist as Scheduling
    const id = createSandboxId(crypto.randomUUID());
    const initial: Sandbox = {
      id,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      tags: input.tags ?? [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: SandboxStatus.Scheduling,
      version: generateVersionId(),
      config: input,
      network: {} as NetworkInfo,
      containers: [] as ContainerRuntime[],
      events: [] as ContainerEvent[],
    } as Sandbox;

    const created = await this.atomic.set<Sandbox>(`${KEY_PREFIX}${id}`, initial, null);
    if (!created) throw new AppError(500, 'CREATE_FAILED', 'Failed to persist initial sandbox state');

    // 2. Build provider input and create cloud resource
    const providerInput = toContainerGroupInput(input);
    const { providerId } = await this.containerProvider.create(providerInput);

    // 3. Transition to Running with provider details (no redundant re-read: we just
    //    wrote `initial` with OCC create-only at line 71, so it's the current state).
    const running: Sandbox = {
      ...initial,
      status: SandboxStatus.Running,
      providerId,
      updatedAt: Date.now(),
      version: generateVersionId(),
    } as Sandbox;

    const updated = await this.atomic.set(`${KEY_PREFIX}${id}`, running, created);
    if (!updated) throw new AppError(409, 'CONFLICT', 'Concurrent modification during provision');

    if (idempotencyKey) {
      await this.atomic.set(`${KEY_PREFIX}idem:${idempotencyKey}`, running, null);
    }

    await this.logger.logAsync({
      facility: FACILITY,
      level: LogLevel.INFO,
      message: 'Sandbox provisioned',
      metadata: { sandboxId: id as string, providerId, name: input.name },
    });

    return running;
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

  async syncRuntime(id: SandboxId): Promise<ContainerGroupRuntime> {
    // Single read — reuse its version for OCC at write time, avoiding a redundant
    // second read before the set() below.
    const entry = await this.atomic.get<Sandbox>(`${KEY_PREFIX}${id}`);
    if (!entry) throw new AppError(404, 'SANDBOX_NOT_FOUND', `Sandbox ${id} not found`);
    const sandbox = entry.value;

    const result = await this.containerProvider.describe({
      region: sandbox.config.region,
      sandboxId: id,
    });

    const runtime = result.sandboxes[0];
    if (!runtime) {
      throw new AppError(404, 'RUNTIME_NOT_FOUND', `No runtime found for sandbox ${id} from provider`);
    }

    const mapped = mapProviderStatus(runtime.status);
    const finalStatus = mapped && mapped !== sandbox.status && isValidTransition(sandbox.status, mapped)
      ? mapped
      : sandbox.status;

    const updated: Sandbox = {
      ...sandbox,
      network: runtimeToNetwork(runtime.network, runtime.associatedResources),
      containers: runtimeToContainers(runtime),
      events: runtimeToEvents(runtime),
      status: finalStatus,
      updatedAt: Date.now(),
      version: generateVersionId(),
    };

    const newVersion = await this.atomic.set(`${KEY_PREFIX}${id}`, updated, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification during syncRuntime');

    await this.logger.logAsync({
      facility: FACILITY,
      level: LogLevel.DEBUG,
      message: `Sandbox runtime synced (${runtime.status})`,
      metadata: { sandboxId: id as string, providerStatus: runtime.status, containers: runtime.containers.length },
    });

    return runtime;
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

// ─── Metrics service ───

export class SandboxMetricsService implements ISandboxMetricsService {
  constructor(
    private readonly metricsProvider: IMetricsProvider,
    private readonly defaultRegion: string = 'unknown',
  ) {}

  async collect(sandboxId: SandboxId): Promise<readonly MetricSnapshot[]> {
    const result = await this.metricsProvider.fetchMetrics({
      region: this.defaultRegion,
      providerId: String(sandboxId),
    });
    return result.snapshots;
  }

  async query(_sandboxId: SandboxId, _range: MetricTimeRange): Promise<readonly MetricSnapshot[]> {
    throw new AppError(501, 'NOT_IMPLEMENTED', 'MetricSnapshot query is not yet implemented');
  }
}

// ─── Log service ───

export class SandboxLogService implements ISandboxLogService {
  constructor(
    private readonly containerProvider: IContainerProvider,
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

// ─── Input mapping ───

export function toContainerGroupInput(input: CreateSandboxInput): CreateContainerGroupInput {
  return {
    name: input.name,
    description: input.description,
    region: input.region,
    cpu: input.resourceSpec.cpu,
    memory: input.resourceSpec.memory,
    spotStrategy: input.spotStrategy,
    restartPolicy: input.restartPolicy,
    containers: input.containers.map(c => ({
      name: c.name,
      image: c.image,
      args: c.args,
      tty: c.tty,
      stdin: c.stdin,
      imagePullPolicy: c.imagePullPolicy,
      volumeMounts: c.volumeMounts?.map(vm => ({
        volumeId: String(vm.volumeId),
        mountPath: vm.mountPath,
        readOnly: vm.readOnly,
        mountPropagation: vm.mountPropagation,
      })),
      providerOverrides: c.providerOverrides,
    })),
    volumes: input.volumes?.map(v => ({
      id: String(v.id),
      type: v.type,
      nfs: v.nfs ? { server: v.nfs.server, path: v.nfs.path, readOnly: v.nfs.readOnly } : undefined,
    })),
    network: {
      subnetIds: input.network.subnetIds,
      securityGroupId: input.network.securityGroupId,
      allocatePublicIp: input.network.allocatePublicIp,
      publicIpBandwidth: input.network.publicIpBandwidth,
    },
    tags: input.tags?.map(t => ({ key: t.key, value: t.value })),
    providerOverrides: input.providerOverrides,
  };
}

// ─── Runtime mapping helpers ───

function eipFromResources(resources: ContainerGroupRuntime['associatedResources']): string | undefined {
  const eip = resources.find(r => r.type === 'eip');
  return eip?.ip;
}

function runtimeToNetwork(
  network: ContainerGroupRuntime['network'],
  associatedResources: ContainerGroupRuntime['associatedResources'],
): NetworkInfo {
  const publicIp = eipFromResources(associatedResources);
  return {
    ...(publicIp !== undefined ? { publicIp } : {}),
    ...(network.privateIp !== undefined ? { privateIp: network.privateIp } : {}),
    ...(network.vpcId !== undefined ? { vpcId: network.vpcId } : {}),
    ...(network.vswitchId !== undefined ? { subnetId: network.vswitchId } : {}),
    ...(network.securityGroupId !== undefined ? { securityGroupId: network.securityGroupId } : {}),
    ...(network.eniId !== undefined ? { eniId: network.eniId } : {}),
  };
}

function runtimeToContainers(r: ContainerGroupRuntime): ContainerRuntime[] {
  return r.containers.map(c => ({
    name: c.name,
    image: c.image,
    cpu: c.resources?.cpu ?? 0,
    memory: c.resources?.memory ?? 0,
    state: {
      state: ociStatusToContainerState(c.status),
      ready: c.status === 'running',
      restartCount: 0,
      ...(c.startedAt !== undefined ? { startTime: c.startedAt } : {}),
    },
    volumeMounts: c.mounts.map(m => ({
      volumeId: undefined as never,
      mountPath: m.destination,
      readOnly: false,
      ...(m.options?.includes('ro') ? { readOnly: true } : {}),
    })),
  }));
}

/** Map OCI container status to the sandbox entity's ContainerState. */
function ociStatusToContainerState(s: OciContainerStatus): 'Running' | 'Waiting' | 'Terminated' {
  switch (s) {
    case 'running': return 'Running';
    case 'paused': return 'Running';
    case 'stopped':
    case 'error':
    case 'deleted': return 'Terminated';
    case 'creating':
    case 'created':
    default: return 'Waiting';
  }
}

function runtimeToEvents(r: ContainerGroupRuntime): ContainerEvent[] {
  return r.events.map(e => ({
    _brand: 'ValueObject' as const,
    reason: e.reason,
    type: e.type,
    message: e.message,
    count: e.count,
    ...(e.lastTimestamp !== undefined ? { lastTimestamp: e.lastTimestamp } : {}),
  }));
}

function mapProviderStatus(providerStatus: ContainerGroupRuntime['status']): SandboxStatus | null {
  switch (providerStatus) {
    case 'Running': return null;
    case 'Failed': return SandboxStatus.Failed;
    case 'Expired':
    case 'Expiring': return SandboxStatus.Terminated;
    case 'Succeeded': return SandboxStatus.Stopped;
    default: return null;
  }
}
