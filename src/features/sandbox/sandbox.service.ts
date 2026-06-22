import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { ILogWriter } from '../../core/logger/interfaces.ts';
import type {
  IContainerProvider,
  IMetricsProvider,
  IProviderRegistry,
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
  ContainerHealth,
  LogQueryOptions,
  MetricTimeRange,
} from './interfaces.ts';
import type { ContainerLogResult } from '../../core/provider/interfaces.ts';
import { LogLevel } from '../../core/types.ts';
import { createFacility, generateVersionId } from '../../core/brand.ts';
import type { RegionId } from '../../core/region/types.ts';
import { createRegionId } from '../../core/region/types.ts';
import { AppError } from '../../core/types.ts';
import type { EventBus } from '../../core/event-bus/bus.ts';
import { createEvent } from '../../core/event-bus/types.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import { KernLevel } from '../../core/audit/kern-level.ts';
import type { NetworkResolverFn } from '../../core/network/types.ts';
import type { InstanceService } from '../../core/region/instance.ts';
import type { IMessageQueue } from '../../queue/interfaces.ts';
import { mapEnvVars, mapPorts, mapVolumeMounts, mapVolumes, mapTags, mapNetwork } from '../../core/provider/mapper.ts';
import { QuotaService } from './quota.ts';

const FACILITY = createFacility('sandbox-service');
const KEY_PREFIX = 'sandbox:';
const INDEX_KEY = 'sandbox:ids';
// ─── Service ───

export class SandboxService implements ISandboxService {
  constructor(
    private readonly atomic: IAtomicStore,
    private readonly logger: ILogWriter,
    private readonly containerProvider: IContainerProvider,
    private readonly providerRegistry?: IProviderRegistry | undefined,
    private readonly eventBus?: EventBus,
    private readonly audit?: IAuditWriter,
    /** Optional: resolve a VirtualNetwork by ID to inherit security settings. */
    private readonly resolveNetwork?: NetworkResolverFn | undefined,
    /** Optional: resolve ComputeInstance by ID to get endpoint/capabilities. */
    private readonly instanceService?: InstanceService | undefined,
    private readonly queueProducer?: IMessageQueue,
  ) {}

  async #enqueueGcRetry(id: string, sandbox: Sandbox): Promise<void> {
    if (!this.queueProducer?.sendSandboxGc) return;
    await this.queueProducer.sendSandboxGc({
      sandboxId: id,
      reason: 'manual',
      providerId: sandbox.providerId ?? id,
      region: sandbox.config.region as unknown as string,
      ...(sandbox.config.instanceId ? { instanceId: sandbox.config.instanceId as any } : {}),
      containerCount: sandbox.containers.length,
      sandboxName: sandbox.name,
      createdAt: sandbox.createdAt,
    }).catch(() => {});
  }

  /** Resolve the container provider, optionally by instanceId. Falls back to default. */
  async #resolveProvider(instanceId?: string): Promise<IContainerProvider> {
    if (this.providerRegistry?.resolveContainer && instanceId) {
      const p = await this.providerRegistry.resolveContainer(instanceId as any);
      if (p) return p;
    }
    return this.containerProvider;
  }

  async provision(input: CreateSandboxInput, idempotencyKey?: string): Promise<Sandbox> {
    if (idempotencyKey) {
      const existing = await this.atomic.get<Sandbox>(`${KEY_PREFIX}idem:${idempotencyKey}`);
      if (existing) return existing.value;
    }

    // 0. Resolve VirtualNetwork reference if specified — merges securityGroupId/subnetIds
    const resolvedNet = input.network.networkId && this.resolveNetwork
      ? await this.resolveNetwork(input.network.networkId)
      : null;
    let mergedNetwork = resolvedNet
      ? {
          ...input.network,
          securityGroupId: input.network.securityGroupId ?? resolvedNet.securityGroupId,
          subnetIds: input.network.subnetIds?.length ? input.network.subnetIds : resolvedNet.subnetIds,
        }
      : input.network;

    // 0b. Resolve ComputeInstance reference if specified
    const resolvedInst = input.instanceId && this.instanceService
      ? await this.instanceService.get(input.instanceId as any)
      : null;
    if (resolvedInst) {
      mergedNetwork = { ...mergedNetwork, instanceId: resolvedInst.id as any };
    }

    // 0c. Check user quota before provisioning
    if (input.creatorId) {
      const quotaService = new QuotaService(this.atomic, this.audit);
      await quotaService.checkQuota(input.creatorId, input.resourceSpec.cpu, input.resourceSpec.memory);
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
      config: { ...input, ...(resolvedInst ? { instanceId: resolvedInst.id as any } : {}), network: mergedNetwork },
      ...(input.creatorId ? { creatorId: input.creatorId } : {}),
      network: {} as NetworkInfo,
      containers: [] as ContainerRuntime[],
      events: [] as ContainerEvent[],
    } as Sandbox;

    const created = await this.atomic.set<Sandbox>(`${KEY_PREFIX}${id}`, initial, null);
    if (!created) throw new AppError(500, 'CREATE_FAILED', 'Failed to persist initial sandbox state');

    // Add to sandbox ID index
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    await this.atomic.set(INDEX_KEY, [...(idx?.value ?? []), id], idx?.version ?? null);

    // 2. Build provider input (with merged VNet + cluster settings) and create cloud resource
    const clusterEnriched = resolvedInst
      ? { ...input, instanceId: resolvedInst.id as any, network: mergedNetwork, zoneId: resolvedInst.zone as string }
      : { ...input, network: mergedNetwork };

    // 3. Resolve SecurityGroup system UID (sg_*) → cloud ID + bandwidth
    if (mergedNetwork?.securityGroupId?.startsWith('sg_')) {
      const sgEntry = await this.atomic.get<any>('secgroup:' + mergedNetwork.securityGroupId);
      if (sgEntry?.value) {
        const sg = sgEntry.value;
        (clusterEnriched as any).network = {
          ...clusterEnriched.network,
          securityGroupId: sg.securityGroupId ?? mergedNetwork.securityGroupId,
          ...(sg.bandwidth ? { bandwidth: sg.bandwidth } : {}),
        };
      }
    }

    const providerInput = toContainerGroupInput(clusterEnriched);

    // 3b. Auto-generate S3 access keys for buckets with autoGenerateKeys
    const BINDING_PREFIX = 'bucket-key:';
    const BINDING_INDEX_KEY = 'bucket-key:ids';
    if (input.bucketMounts?.length) {
      (providerInput as any).secretMounts ??= [];
      for (const bm of input.bucketMounts) {
        if (!bm.autoGenerateKeys) continue;
        const ak = `auto_${crypto.randomUUID().slice(0, 12)}`;
        const sk = Array.from(crypto.getRandomValues(new Uint8Array(32)))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');
        const secretValue = `${ak}:${sk}`;
        const binding = {
          sandboxId: id as string,
          bucketId: bm.bucketId,
          secretValue,
          accessKeyId: ak,
          version: 1,
          expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          rotationIntervalMs: 24 * 60 * 60 * 1000,
          createdAt: Date.now(),
        };
        await this.atomic.set(BINDING_PREFIX + id, binding, null);
        const idx_ = await this.atomic.get<string[]>(BINDING_INDEX_KEY);
        await this.atomic.set(BINDING_INDEX_KEY, [...(idx_?.value ?? []), id as string], idx_?.version ?? null);
        (providerInput as any).secretMounts.push({
          mountPath: bm.mountPath,
          data: secretValue,
          mode: 0o600,
        });
      }
    }

    const containerProvider = await this.#resolveProvider(input.instanceId);
    let providerId: string;
    try {
      ({ providerId } = await containerProvider.create(providerInput));
    } catch (e) {
      // Provider creation failed — mark sandbox as Failed so it's not orphaned
      await this.atomic.set(`${KEY_PREFIX}${id}`, { ...initial, status: SandboxStatus.Failed, updatedAt: Date.now() }, created).catch(() => {});
      throw translateProviderError(e, input.name);
    }

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

    // Record quota usage
    if (input.creatorId) {
      const quotaService = new QuotaService(this.atomic, this.audit);
      await quotaService.recordCreate(input.creatorId, input.resourceSpec.cpu, input.resourceSpec.memory);
    }

    if (idempotencyKey) {
      await this.atomic.set(`${KEY_PREFIX}idem:${idempotencyKey}`, running, null);
    }

    await this.logger.logAsync({
      facility: FACILITY,
      level: LogLevel.NOTICE,
      message: 'Sandbox provisioned',
      actorId: input.creatorId,
      metadata: { sandboxId: id as string, providerId, name: input.name },
    });

    this.audit?.write({
      level: KernLevel.NOTICE,
      facility: FACILITY,
      message: `Sandbox provisioned — ${input.name}`,
      actorId: input.creatorId,
      metadata: { eventType: 'sandbox.provisioned', sandboxId: id as string, providerId },
    });

    // Notify real-time subscribers
    this.eventBus?.dispatch(createEvent('sandbox.provisioned', {
      sandboxId: id as string,
      status: SandboxStatus.Running,
      name: input.name,
      creatorId: input.creatorId,
      providerId,
    }));

    return running;
  }

  async getById(id: SandboxId): Promise<Sandbox | null> {
    const entry = await this.atomic.get<Sandbox>(`${KEY_PREFIX}${id}`);
    return entry?.value ?? null;
  }

  async list(status?: SandboxStatus, limit = 50, cursor?: string): Promise<{ items: Sandbox[]; nextCursor?: string }> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    if (!idx) return { items: [] };

    let ids = idx.value;
    // Apply cursor (array index)
    const startIdx = cursor ? parseInt(cursor, 10) : 0;
    if (isNaN(startIdx) || startIdx >= ids.length) return { items: [] };

    ids = ids.slice(startIdx, startIdx + limit);

    const entries = await Promise.all(
      ids.map(id => this.atomic.get<Sandbox>(`${KEY_PREFIX}${id}`)),
    );

    let items = entries.filter(e => e !== null).map(e => e!.value);

    // Optional status filter
    if (status) {
      items = items.filter(s => s.status === status);
    }

    const nextCursorVal = startIdx + limit < (idx?.value.length ?? 0)
      ? String(startIdx + limit)
      : undefined;

    return { items, ...(nextCursorVal !== undefined ? { nextCursor: nextCursorVal } : {}) };
  }

  async stop(id: SandboxId): Promise<Sandbox> {
    const sandbox = await this.getById(id);
    if (!sandbox) throw new AppError(404, 'SANDBOX_NOT_FOUND', `Sandbox ${id} not found`);

    // Tell the provider to stop the container (best-effort)
    try {
      const provider = await this.#resolveProvider(sandbox.config.instanceId);
      await provider.stop?.(sandbox.providerId ?? String(id));
    } catch {
      // Provider may be unreachable or container already stopped — proceed.
    }

    return this.transition(id, SandboxStatus.Stopped, 'user requested stop');
  }

  async start(id: SandboxId): Promise<Sandbox> {
    const sandbox = await this.getById(id);
    if (!sandbox) throw new AppError(404, 'SANDBOX_NOT_FOUND', `Sandbox ${id} not found`);

    try {
      const provider = await this.#resolveProvider(sandbox.config.instanceId);
      await provider.start?.(sandbox.providerId ?? String(id));
    } catch {
      // Provider unreachable — proceed with local state
    }

    return this.transition(id, SandboxStatus.Running, 'user requested start');
  }

  async terminate(id: SandboxId, actorId?: string): Promise<void> {
    const sandbox = await this.getById(id);
    if (!sandbox) throw new AppError(404, 'SANDBOX_NOT_FOUND', `Sandbox ${id} not found`);

    // Clean up auto-generated S3 bucket keys
    const BINDING_PREFIX = 'bucket-key:';
    const BINDING_INDEX_KEY = 'bucket-key:ids';
    const bindingEntry = await this.atomic.get<any>(BINDING_PREFIX + id);
    if (bindingEntry) {
      await this.atomic.set(BINDING_PREFIX + id, null, bindingEntry.version);
      const idx_ = await this.atomic.get<string[]>(BINDING_INDEX_KEY);
      if (idx_) {
        await this.atomic.set(BINDING_INDEX_KEY, idx_.value.filter((i: string) => i !== id), idx_.version);
      }
    }

    // Provider cleanup — sync delete + async GC retry for reliability
    if (sandbox.providerId) {
      try {
        const provider = await this.#resolveProvider(sandbox.config.instanceId);
        await provider.delete({ region: sandbox.config.region, providerId: sandbox.providerId });
      } catch (e) {
        console.error(`[sandbox] terminate: provider delete failed for ${id} (${sandbox.providerId}), enqueuing GC — ${e instanceof Error ? e.message : String(e)}`);
        this.#enqueueGcRetry(id as string, sandbox);
      }
    } else {
      console.error(`[sandbox] terminate: sandbox ${id} has no providerId — cloud resource may be orphaned`);
    }

    await this.transition(id, SandboxStatus.Deleted, 'user requested termination', actorId);

    // Remove from sandbox ID index
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    if (idx) await this.atomic.set(INDEX_KEY, idx.value.filter((i: string) => i !== id), idx.version);

    await this.logger.logAsync({
      facility: FACILITY,
      level: LogLevel.NOTICE,
      message: 'Sandbox terminated',
      actorId,
      metadata: { sandboxId: id as string },
    });

    this.audit?.write({
      level: KernLevel.WARNING,
      facility: FACILITY,
      message: `Sandbox terminated — ${id}`,
      actorId,
      metadata: { eventType: 'sandbox.terminated', sandboxId: id as string },
    });
  }

  async forceTransition(id: SandboxId, to: SandboxStatus, reason: string, actorId?: string): Promise<Sandbox> {
    return this.transition(id, to, reason, actorId);
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

  async getHealth(id: SandboxId): Promise<readonly ContainerHealth[]> {
    const sandbox = await this.getById(id);
    if (!sandbox) throw new AppError(404, 'SANDBOX_NOT_FOUND', `Sandbox ${id} not found`);

    // Sync from provider only when Running to get real-time health
    if (sandbox.status === SandboxStatus.Running) {
      try {
        await this.syncRuntime(id);
      } catch { /* stale data is acceptable */ }
    }

    const updated = await this.getById(id);
    const target = updated ?? sandbox;

    // Non-Running sandboxes: containers are not healthy regardless of cached state
    const sandboxDone = target.status !== SandboxStatus.Running && target.status !== SandboxStatus.Pending && target.status !== SandboxStatus.Scheduling;

    if (sandboxDone) {
      return target.containers.map(c => ({
        containerName: c.name,
        status: 'stopped',
        ready: false,
        startedAt: c.state.startTime,
        message: `Sandbox is ${target.status.toLowerCase()}`,
      }));
    }

    return target.containers.map(c => ({
      containerName: c.name,
      status: c.health?.status ?? (c.state.state === 'Running' ? 'running' : c.state.state === 'Waiting' ? 'starting' : 'none'),
      ready: c.state.ready,
      startedAt: c.state.startTime,
      message: c.health?.message ?? c.state.message,
    }));
  }

  async syncRuntime(id: SandboxId): Promise<ContainerGroupRuntime> {
    // Single read — reuse its version for OCC at write time, avoiding a redundant
    // second read before the set() below.
    const entry = await this.atomic.get<Sandbox>(`${KEY_PREFIX}${id}`);
    if (!entry) throw new AppError(404, 'SANDBOX_NOT_FOUND', `Sandbox ${id} not found`);
    const sandbox = entry.value;

    if (!sandbox.providerId) {
      throw new AppError(404, 'PROVIDER_ID_MISSING', `Sandbox ${id} has no providerId — provider resource was never created or was cleaned up`);
    }
    const provider = await this.#resolveProvider(sandbox.config.instanceId);
    const result = await provider.describe({
      region: sandbox.config.region,
      sandboxId: sandbox.providerId,
    });

    const runtime = result.sandboxes[0];
    if (!runtime) {
      throw new AppError(404, 'RUNTIME_NOT_FOUND', `No runtime found for sandbox ${id} from provider`);
    }

    const mapped = mapProviderStatus(runtime.status);
    const finalStatus = mapped && mapped !== sandbox.status && isValidTransition(sandbox.status, mapped)
      ? mapped
      : sandbox.status;

    // Persist clusterId from runtime if provider reported it back
    const runtimeInstanceId = runtime.instanceId ?? sandbox.config.instanceId;

    const updated: Sandbox = {
      ...sandbox,
      network: runtimeToNetwork(runtime.network, runtime.associatedResources),
      containers: runtimeToContainers(runtime),
      events: runtimeToEvents(runtime),
      status: finalStatus,
      ...(runtimeInstanceId ? { config: { ...sandbox.config, instanceId: runtimeInstanceId } } : {}),
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

  private async transition(id: SandboxId, to: SandboxStatus, reason: string, actorId?: string): Promise<Sandbox> {
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

    const uptime = Date.now() - from.createdAt;
    const meta = {
      eventType: 'sandbox.transition' as const,
      sandboxId: id as string,
      name: from.name,
      from: from.status,
      to,
      reason,
      providerId: from.providerId ?? '',
      containers: from.containers.length,
      createdAt: from.createdAt,
      uptimeMs: uptime,
      actorId: actorId ?? '',
    };
    await this.logger.logAsync({
      facility: FACILITY, level: LogLevel.NOTICE,
      message: `sandbox ${from.status}→${to} name=${from.name} provider=${from.providerId ?? ''} containers=${from.containers.length} uptime=${uptime}ms reason=${reason}`,
      actorId,
      metadata: meta,
    });
    this.audit?.write({
      level: KernLevel.INFO, facility: FACILITY,
      message: `Sandbox ${from.status} → ${to} — ${reason}`,
      actorId,
      metadata: meta,
    });

    this.eventBus?.dispatch(createEvent('sandbox.status', {
      sandboxId: id as string,
      fromStatus: from.status,
      toStatus: to,
      reason,
    }));

    return updated;
  }
}

// ─── Metrics service ───

export class SandboxMetricsService implements ISandboxMetricsService {
  constructor(
    private readonly metricsProvider: IMetricsProvider,
    private readonly defaultRegion: RegionId = createRegionId('unknown'),
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
    private readonly defaultRegion: RegionId = createRegionId('unknown'),
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
    name: sanitizeName(input.name),
    description: input.description,
    region: input.region,
    ...(input.instanceId ? { instanceId: input.instanceId } : {}),
    ...((input as any).zoneId ? { zoneId: (input as any).zoneId } : {}),
    cpu: input.resourceSpec.cpu,
    memory: Math.max(1, Math.ceil(input.resourceSpec.memory / 1024)), // ECI expects GB, applicator provides MB
    gpu: input.resourceSpec.gpu,
    gpuType: input.resourceSpec.gpuType,
    spotStrategy: input.spotStrategy,
    restartPolicy: input.restartPolicy,
    containers: input.containers.map(c => ({
      name: c.name,
      image: c.image,
      command: c.command,
      args: c.args,
      env: mapEnvVars(c.env),
      tty: c.tty,
      stdin: c.stdin,
      imagePullPolicy: c.imagePullPolicy,
      resources: c.resources,
      livenessProbe: c.livenessProbe,
      readinessProbe: c.readinessProbe,
      startupProbe: c.startupProbe,
      ports: mapPorts(c.ports),
      networkMode: c.networkMode,
      volumeMounts: mapVolumeMounts(c.volumeMounts?.map(vm => ({
        volumeId: String(vm.volumeId),
        mountPath: vm.mountPath,
        readOnly: vm.readOnly,
        mountPropagation: vm.mountPropagation,
      }))),
      providerOverrides: c.providerOverrides,
    })),
    volumes: mapVolumes(input.volumes?.map(v => ({
      id: String(v.id),
      type: v.type,
      nfs: v.nfs,
      disk: v.disk,
      secret: v.secret,
    }))),
    network: mapNetwork({
      subnetIds: input.network.subnetIds,
      securityGroupId: input.network.securityGroupId,
      allocatePublicIp: input.network.allocatePublicIp,
      publicIpBandwidth: input.network.publicIpBandwidth,
      bandwidth: input.network.bandwidth,
    }),
    tags: mapTags(input.tags),
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
    ...(network.subnetId !== undefined ? { subnetId: network.subnetId } : {}),
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
      ready: c.health.status === 'healthy' || (c.health.status === 'none' && c.status === 'running'),
      restartCount: 0,
      ...(c.startedAt ? { startTime: c.startedAt } : {}),
    },
    volumeMounts: c.mounts.map(m => ({
      volumeId: undefined as never,
      mountPath: m.destination,
      readOnly: false,
      ...(m.options?.includes('ro') ? { readOnly: true } : {}),
    })),
    health: { status: c.health.status, lastCheckedAt: c.health.lastCheckedAt, message: c.health.message },
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
    case 'Failed':
    case 'ScheduleFailed': return SandboxStatus.Failed;
    case 'Expired':
    case 'Expiring': return SandboxStatus.Terminated;
    case 'Succeeded': return SandboxStatus.Stopped;
    case 'Restarting': return SandboxStatus.Pending;
    case 'Pending':
    case 'Scheduling':
    default: return null;
  }
}

/** 将云厂商错误翻译为用户可读的 AppError */
function translateProviderError(e: unknown, sandboxName: string): AppError {
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();

  if (lower.includes('fetch failed') || lower.includes('econnrefused') || lower.includes('connection refused')) {
    return new AppError(503, 'PROVIDER_UNREACHABLE',
      `Cannot reach container provider for sandbox "${sandboxName}". Is Podman running? Check PODMAN_ENDPOINT or instance connectivity. (detail: ${msg.slice(0, 200)})`);
  }
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid security token') || lower.includes('signature') || lower.includes('invalidaccesskeyid')) {
    return new AppError(401, 'PROVIDER_AUTH_FAILED',
      `Authentication failed for sandbox "${sandboxName}". Check your cloud credentials (ALIBABA_ACCESS_KEY_ID / ALIBABA_ACCESS_KEY_SECRET). (detail: ${msg.slice(0, 200)})`);
  }
  if (lower.includes('403') || lower.includes('forbidden') || lower.includes('accessdenied')) {
    return new AppError(403, 'PROVIDER_FORBIDDEN',
      `Access denied by cloud provider for sandbox "${sandboxName}". Check IAM/RAM permissions. (detail: ${msg.slice(0, 200)})`);
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('etimedout')) {
    return new AppError(504, 'PROVIDER_TIMEOUT',
      `Cloud provider timed out for sandbox "${sandboxName}". Check network connectivity and provider health. (detail: ${msg.slice(0, 200)})`);
  }
  if (lower.includes('not found') || lower.includes('404') || lower.includes('nosuchbucket') || lower.includes('nosuchkey')) {
    return new AppError(404, 'PROVIDER_NOT_FOUND',
      `Cloud resource not found for sandbox "${sandboxName}". Check that the target resource exists. (detail: ${msg.slice(0, 200)})`);
  }
  if (lower.includes('quota') || lower.includes('limit exceeded') || lower.includes('throttl')) {
    return new AppError(429, 'PROVIDER_QUOTA_EXCEEDED',
      `Cloud provider quota exceeded for sandbox "${sandboxName}". Check your account limits. (detail: ${msg.slice(0, 200)})`);
  }

  // Generic fallback with original message preserved
  return new AppError(502, 'PROVIDER_ERROR',
    `Cloud provider failed for sandbox "${sandboxName}": ${msg.slice(0, 300)}`);
}

/** Sanitize sandbox name for provider API constraints (Alibaba ECI: [a-zA-Z][a-zA-Z0-9._-]{1,62}). */
function sanitizeName(name: string): string {
  let s = name.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 63).replace(/^-+|-+$/g, '');
  if (!s || s.length < 2) s = 'sandbox-' + Date.now().toString(36);
  if (!/^[a-zA-Z]/.test(s)) s = 's-' + s;
  return s;
}
