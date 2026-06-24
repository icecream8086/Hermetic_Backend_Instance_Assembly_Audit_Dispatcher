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
import { ProviderResolutionError, ProviderOperationError } from '../../core/provider/errors.ts';
import type { EventBus } from '../../core/event-bus/bus.ts';
import { createEvent } from '../../core/event-bus/types.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import { KernLevel } from '../../core/audit/kern-level.ts';
import type { NetworkResolverFn } from '../../core/network/types.ts';
import type { InstanceService } from '../../core/region/instance.ts';
import type { IMessageQueue } from '../../queue/interfaces.ts';
import { mapEnvVars, mapPorts, mapVolumeMounts, mapVolumes, mapTags, mapNetwork } from '../../core/provider/mapper.ts';
import { QuotaService } from './quota.ts';
import { SandboxStore } from './sandbox-store.ts';

const FACILITY = createFacility('sandbox-service');
const KEY_PREFIX = 'sandbox:';
// ─── Service ───

export class SandboxService implements ISandboxService {
  private readonly store: SandboxStore;

  constructor(
    private readonly atomic: IAtomicStore,
    private readonly logger: ILogWriter,
    _containerProvider: IContainerProvider, // deprecated — retained for constructor signature compat, unused
    private readonly providerRegistry?: IProviderRegistry | undefined,
    private readonly eventBus?: EventBus,
    private readonly audit?: IAuditWriter,
    /** Optional: resolve a VirtualNetwork by ID to inherit security settings. */
    private readonly resolveNetwork?: NetworkResolverFn | undefined,
    /** Optional: resolve ComputeInstance by ID to get endpoint/capabilities. */
    private readonly instanceService?: InstanceService | undefined,
    private readonly queueProducer?: IMessageQueue,
  ) {
    this.store = new SandboxStore(atomic);
  }

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

  /** Resolve the container provider for a specific instance. Never silently falls back when instanceId is set. */
  async #resolveProvider(instanceId?: string): Promise<IContainerProvider> {
    if (instanceId) {
      if (!this.providerRegistry?.resolveContainer) {
        throw new ProviderResolutionError(
          `Cannot resolve provider for instance "${instanceId}" — SandboxService was constructed without a providerRegistry.`,
          instanceId,
        );
      }
      const p = await this.providerRegistry.resolveContainer(instanceId as any);
      if (p) return p;
      throw new ProviderResolutionError(
        `Failed to resolve container provider for instance "${instanceId}". Check that the instance is online and its credential is valid.`,
        instanceId,
      );
    }
    // No instanceId and no global default — pick first online instance
    if (this.providerRegistry?.resolveContainer) {
      const p = await this.providerRegistry.resolveContainer(undefined);
      if (p) return p;
    }
    throw new ProviderResolutionError(
      'Cannot resolve provider: no instanceId specified and no global default configured. Pass an explicit instanceId or ensure an online container-capable instance is registered.',
    );
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
    // Build provider identity for persistence (audit trail + deterministic re-resolution)
    const providerIdentity = resolvedInst ? {
      platform: resolvedInst.platform,
      instanceId: resolvedInst.id,
      region: resolvedInst.region,
      zoneId: resolvedInst.zone as string | undefined,
      credentialRef: resolvedInst.credentialRef,
    } : undefined;

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
      config: { ...input, ...(resolvedInst ? { instanceId: resolvedInst.id as any } : {}), network: mergedNetwork, ...(providerIdentity ? { providerIdentity } : {}) },
      ...(input.creatorId ? { creatorId: input.creatorId } : {}),
      network: {} as NetworkInfo,
      containers: [] as ContainerRuntime[],
      events: [] as ContainerEvent[],
    } as Sandbox;

    const created = await this.atomic.set<Sandbox>(`${KEY_PREFIX}${id}`, initial, null);
    if (!created) throw new AppError(500, 'CREATE_FAILED', 'Failed to persist initial sandbox state');

    // Add to sandbox ID index
    await this.store.addToIndex(id as string);

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

    // 3. Transition to Running (sync providers) or Scheduling (async providers like ECI).
    //    ECI returns before containers are actually Running — health check needs the
    //    Scheduling status to apply a grace period before GC.
    const createdStatus = containerProvider.lifecycle.asyncInit
      ? SandboxStatus.Scheduling
      : SandboxStatus.Running;
    const provisioned: Sandbox = {
      ...initial,
      status: createdStatus,
      providerId,
      updatedAt: Date.now(),
      version: generateVersionId(),
    } as Sandbox;

    const updated = await this.atomic.set(`${KEY_PREFIX}${id}`, provisioned, created);
    if (!updated) throw new AppError(409, 'CONFLICT', 'Concurrent modification during provision');

    // Record quota usage
    if (input.creatorId) {
      const quotaService = new QuotaService(this.atomic, this.audit);
      await quotaService.recordCreate(input.creatorId, input.resourceSpec.cpu, input.resourceSpec.memory);
    }

    if (idempotencyKey) {
      await this.atomic.set(`${KEY_PREFIX}idem:${idempotencyKey}`, provisioned, null);
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

    return provisioned;
  }

  async getById(id: SandboxId): Promise<Sandbox | null> {
    return this.store.getById(id);
  }

  async list(status?: SandboxStatus, limit = 50, cursor?: string): Promise<{ items: Sandbox[]; nextCursor?: string }> {
    return this.store.list(status, limit, cursor);
  }

  async stop(id: SandboxId): Promise<Sandbox> {
    const sandbox = await this.getById(id);
    if (!sandbox) throw new AppError(404, 'SANDBOX_NOT_FOUND', `Sandbox ${id} not found`);

    // Tell the provider to stop the container (best-effort)
    const provider = await this.#resolveProvider(sandbox.config.instanceId);
    if (provider.lifecycle.stopIsDelete) {
      // ECI: stop() = delete() — resource is destroyed immediately.
      // Transition directly to Terminated so GC can clean up, rather than
      // going through Stopped which implies the resource still exists.
      try { await provider.stop?.(sandbox.providerId ?? String(id)); } catch { /* best-effort */ }
      return this.transition(id, SandboxStatus.Terminated, 'user requested stop (ECI stop = delete)');
    }

    try {
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
      if (!provider.lifecycle.startable) {
        throw new AppError(400, 'START_NOT_SUPPORTED', `Provider "${provider.lifecycle.stopIsDelete ? 'ECI' : 'unknown'}" does not support start — sandboxes are ephemeral`);
      }
      await provider.start?.(sandbox.providerId ?? String(id));
    } catch {
      // Provider unreachable or start not supported — proceed with local state
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
        console.error(`[sandbox] terminate: provider delete failed name=${sandbox.name} id=${id} provider=${sandbox.providerId} instance=${sandbox.config.instanceId ?? '(none)'} — ${e instanceof Error ? e.message : String(e)}`);
        this.#enqueueGcRetry(id as string, sandbox);
      }
    } else {
      console.error(`[sandbox] terminate: sandbox ${id} has no providerId — cloud resource may be orphaned`);
    }

    await this.transition(id, SandboxStatus.Deleted, 'user requested termination', actorId);

    // Remove from sandbox ID index
    await this.store.removeFromIndex(id as string);

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

    const provider = await this.#resolveProvider(target.config.instanceId);
    return target.containers.map(c => ({
      containerName: c.name,
      status: c.health?.status
        ?? ((c.state.state === 'Running' && !provider.lifecycle.healthProbes) ? 'provider'
          : c.state.state === 'Running' ? 'running'
          : c.state.state === 'Waiting' ? 'starting' : 'none'),
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
    let result;
    try {
      result = await provider.describe({
        region: sandbox.config.region,
        sandboxId: sandbox.providerId,
      });
    } catch (e) {
      throw new ProviderOperationError(
        `Failed to describe sandbox ${id}: ${e instanceof Error ? e.message : String(e)}`,
        'describe',
        sandbox.providerId,
      );
    }

    const runtime = result.sandboxes[0];
    if (!runtime) {
      throw new AppError(404, 'RUNTIME_NOT_FOUND', `No runtime found for sandbox ${id} from provider`);
    }

    const mapped = mapProviderStatus(runtime.status);
    let finalStatus = mapped && mapped !== sandbox.status && isValidTransition(sandbox.status, mapped)
      ? mapped
      : sandbox.status;

    // asyncInit providers (ECI): Scheduling → Running when provider confirms Running
    if (sandbox.status === SandboxStatus.Scheduling && runtime.status === 'Running') {
      finalStatus = SandboxStatus.Running;
    }

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
    const before = await this.store.getById(id);
    const fromStatus = before?.status ?? SandboxStatus.Deleted;
    const createdAt = before?.createdAt ?? Date.now();

    const updated = await this.store.transition(id, to);

    const uptime = Date.now() - createdAt;
    const sandbox = (await this.store.getById(id)) ?? updated;
    const meta = {
      eventType: 'sandbox.transition' as const,
      sandboxId: id as string,
      name: sandbox.name,
      from: fromStatus,
      to,
      reason,
      providerId: sandbox.providerId ?? '',
      containers: sandbox.containers.length,
      createdAt,
      uptimeMs: uptime,
      actorId: actorId ?? '',
    };
    await this.logger.logAsync({
      facility: FACILITY, level: LogLevel.NOTICE,
      message: `sandbox ${fromStatus}→${to} name=${sandbox.name} provider=${sandbox.providerId ?? ''} containers=${sandbox.containers.length} uptime=${uptime}ms reason=${reason}`,
      actorId,
      metadata: meta,
    });
    this.audit?.write({
      level: KernLevel.INFO, facility: FACILITY,
      message: `Sandbox ${fromStatus} → ${to} — ${reason}`,
      actorId,
      metadata: meta,
    });

    this.eventBus?.dispatch(createEvent('sandbox.status', {
      sandboxId: id as string,
      fromStatus,
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
