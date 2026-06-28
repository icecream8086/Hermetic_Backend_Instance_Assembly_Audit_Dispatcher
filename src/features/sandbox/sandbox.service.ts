import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { ILogWriter } from '../../core/audit/types.ts';
import type {
  IContainerProvider,
  IMetricsProvider,
  IProviderRegistry,
  MetricSnapshot,
  ContainerGroupRuntime,
  CreateContainerGroupInput,
  SecretMountConfig,
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
  ContainerConfig,
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
import { KernLevel } from '../../core/audit/kern-level.ts';
import { createFacility, generateVersionId } from '../../core/brand.ts';
import type { RegionId } from '../../core/region/types.ts';
import { createRegionId } from '../../core/region/types.ts';
import type { InstanceId } from '../../core/region/instance.ts';
import { AppError } from '../../core/types.ts';
import { ProviderResolutionError, ProviderOperationError } from '../../core/provider/errors.ts';
import type { EventBus } from '../../core/event-bus/bus.ts';
import { createEvent } from '../../core/event-bus/types.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import type { NetworkResolverFn } from '../../core/network/types.ts';
import type { InstanceService } from '../../core/region/instance.ts';
import type { IMessageQueue } from '../../queue/interfaces.ts';
import { mapEnvVars, mapPorts, mapVolumeMounts, mapVolumes, mapTags, mapNetwork } from '../../core/provider/mapper.ts';
import { QuotaService } from './quota.ts';
import { SandboxStore } from './sandbox-store.ts';
import { runtimeToNetwork, runtimeToContainers, runtimeToEvents } from './runtime-mapper.ts';

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
      region: sandbox.config.region,
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
      ? await this.instanceService.get(input.instanceId)
      : null;
    if (resolvedInst) {
      mergedNetwork = { ...mergedNetwork, instanceId: resolvedInst.id };
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
      config: { ...input, ...(resolvedInst ? { instanceId: resolvedInst.id } : {}), network: mergedNetwork, ...(providerIdentity ? { providerIdentity } : {}) },
      ...(input.creatorId ? { creatorId: input.creatorId } : {}),
      network: {},
      containers: [] as ContainerRuntime[],
      events: [] as ContainerEvent[],
    };

    const created = await this.atomic.set<Sandbox>(`${KEY_PREFIX}${id}`, initial, null);
    if (!created) throw new AppError(500, 'CREATE_FAILED', 'Failed to persist initial sandbox state');

    // Add to sandbox ID index
    await this.store.addToIndex(id);

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

    const baseInput = toContainerGroupInput(clusterEnriched);

    // 3b. Auto-generate S3 access keys for buckets with autoGenerateKeys
    const BINDING_PREFIX = 'bucket-key:';
    const BINDING_INDEX_KEY = 'bucket-key:ids';
    let providerInput = baseInput;
    if (input.bucketMounts?.length) {
      const secretMounts: SecretMountConfig[] = [];
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
        secretMounts.push({
          mountPath: bm.mountPath,
          data: secretValue,
          mode: 0o600,
        });
      }
      if (secretMounts.length > 0) {
        providerInput = { ...baseInput, secretMounts };
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
    };

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

    await this.logger.write({
      facility: FACILITY,
      level: KernLevel.NOTICE,
      message: 'Sandbox provisioned',
      actorId: input.creatorId,
      metadata: { sandboxId: id, providerId, name: input.name },
    });

    this.audit?.write({
      level: KernLevel.NOTICE,
      facility: FACILITY,
      message: `Sandbox provisioned — ${input.name}`,
      actorId: input.creatorId,
      metadata: { eventType: 'sandbox.provisioned', sandboxId: id, providerId },
    });

    // Notify real-time subscribers
    this.eventBus?.dispatch(createEvent('sandbox.provisioned', {
      sandboxId: id,
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
      return this.transition(id, SandboxStatus.Terminating, 'user requested stop (ECI stop = delete)');
    }

    try {
      await provider.stop?.(sandbox.providerId ?? String(id));
    } catch {
      // Provider may be unreachable or container already stopped — proceed.
    }

    return this.transition(id, SandboxStatus.Succeeded, 'user requested stop');
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

  /**
   * Terminate a sandbox — transition to Terminating, call provider.delete(),
   * then transition to Deleted on success. If provider delete fails, the
   * sandbox stays in Terminating and the health-check GC path retries.
   *
   * GHA analogy: DeleteRun → run is gone. ECI analogy: DeleteContainerGroup →
   * Terminating → (async cleanup) → Deleted. We bridge both: the user sees an
   * immediate state change to Terminating, but Deleted is only reached after
   * the cloud resource is confirmed gone.
   */
  async terminate(id: SandboxId, actorId?: string): Promise<void> {
    const sandbox = await this.getById(id);
    if (!sandbox) throw new AppError(404, 'SANDBOX_NOT_FOUND', `Sandbox ${id} not found`);

    // Idempotent: already deleted
    if (sandbox.status === SandboxStatus.Deleted) return;

    // Already terminating — re-trigger provider delete for safety, then return
    if (sandbox.status === SandboxStatus.Terminating) {
      if (sandbox.providerId) {
        try {
          const provider = await this.#resolveProvider(sandbox.config.instanceId);
          await provider.delete({ region: sandbox.config.region, providerId: sandbox.providerId });
        } catch { /* GC will retry */ }
      }
      return;
    }

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

    // Hard terminals with no cloud resource — delete directly
    if (sandbox.status === SandboxStatus.ScheduleFailed || sandbox.status === SandboxStatus.Expired) {
      await this.transition(id, SandboxStatus.Deleted, 'user requested termination (no cloud resource)', actorId);
      await this.store.removeFromIndex(id);
      await this.logTerminated(id, actorId);
      return;
    }

    // Normal path: transition to Terminating first (validates deletable state via
    // isValidTransition). Only then attempt provider cleanup.
    await this.transition(id, SandboxStatus.Terminating, 'user requested termination', actorId);

    if (sandbox.providerId) {
      try {
        const provider = await this.#resolveProvider(sandbox.config.instanceId);
        await provider.delete({ region: sandbox.config.region, providerId: sandbox.providerId });
        // Cloud resource confirmed deleted — advance to Deleted
        await this.transition(id, SandboxStatus.Deleted, 'provider cleanup complete', actorId);
        await this.store.removeFromIndex(id);
      } catch (e) {
        console.error(`[sandbox] terminate: provider delete failed name=${sandbox.name} id=${id} provider=${sandbox.providerId} instance=${sandbox.config.instanceId ?? '(none)'} — ${e instanceof Error ? e.message : String(e)}`);
        // Enqueue GC retry — sandbox stays in Terminating, health-check will re-dispatch
        this.#enqueueGcRetry(id, sandbox);
      }
    } else {
      console.error(`[sandbox] terminate: sandbox ${id} has no providerId — cloud resource may be orphaned`);
      // No cloud resource to clean up — advance to Deleted directly
      await this.transition(id, SandboxStatus.Deleted, 'no provider resource to clean up', actorId);
      await this.store.removeFromIndex(id);
    }

    await this.logTerminated(id, actorId);
  }

  private async logTerminated(id: SandboxId, actorId?: string): Promise<void> {
    await this.logger.write({
      facility: FACILITY,
      level: KernLevel.NOTICE,
      message: 'Sandbox terminated',
      actorId,
      metadata: { sandboxId: id },
    });
    this.audit?.write({
      level: KernLevel.WARNING,
      facility: FACILITY,
      message: `Sandbox terminated — ${id}`,
      actorId,
      metadata: { eventType: 'sandbox.terminated', sandboxId: id },
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

	  async restart(id: SandboxId): Promise<Sandbox> {
	    const sandbox = await this.getById(id);
	    if (!sandbox) throw new AppError(404, 'SANDBOX_NOT_FOUND', `Sandbox ${id} not found`);

	    if (sandbox.status !== SandboxStatus.Running) {
	      throw new AppError(409, 'RESTART_NOT_ALLOWED', `Cannot restart sandbox in ${sandbox.status} state — only Running is valid`);
	    }

	    const provider = await this.#resolveProvider(sandbox.config.instanceId);
	    if (!provider.restart) {
	      throw new AppError(501, 'RESTART_NOT_SUPPORTED', `Provider does not support restart`);
	    }

	    await this.transition(id, SandboxStatus.Restarting, 'user requested restart');

	    try {
	      await provider.restart(sandbox.providerId ?? String(id));
	    } catch (e) {
	      console.error(`[sandbox] restart: provider call failed name=${sandbox.name} id=${id} — ${e instanceof Error ? e.message : String(e)}`);
	      // Sandbox stays in Restarting — syncRuntime or health-check will converge
	    }

	    return (await this.getById(id)) ?? sandbox;
	  }

	  async update(id: SandboxId, input: Partial<CreateSandboxInput>): Promise<Sandbox> {
	    const sandbox = await this.getById(id);
	    if (!sandbox) throw new AppError(404, 'SANDBOX_NOT_FOUND', `Sandbox ${id} not found`);

	    if (sandbox.status !== SandboxStatus.Running) {
	      throw new AppError(409, 'UPDATE_NOT_ALLOWED', `Cannot update sandbox in ${sandbox.status} state`);
	    }

	    const provider = await this.#resolveProvider(sandbox.config.instanceId);
	    if (!provider.update) {
	      throw new AppError(501, 'UPDATE_NOT_SUPPORTED', `Provider does not support update`);
	    }

	    await this.transition(id, SandboxStatus.Updating, 'user requested update');

	    const mapped = toPartialContainerGroupInput(input, sandbox.config);
	    try {
	      await provider.update(sandbox.providerId ?? String(id), mapped);
	    } catch (e) {
	      console.error(`[sandbox] update: provider call failed name=${sandbox.name} id=${id} -- ${e instanceof Error ? e.message : String(e)}`);
	    }

	    if (Object.keys(mapped).length > 0) {
	      const entry = await this.atomic.get<Sandbox>(`${KEY_PREFIX}${id}`);
	      if (entry) {
	        const mergedConfig = { ...entry.value.config, ...input, network: { ...entry.value.config.network, ...(input.network ?? {}) } };
	        const updated: Sandbox = { ...entry.value, config: mergedConfig, updatedAt: Date.now(), version: generateVersionId() };
	        await this.atomic.set(`${KEY_PREFIX}${id}`, updated, entry.version);
	      }
	    }

	    return (await this.getById(id)) ?? sandbox;
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

    // Restarting → Running when restart completes
    if (sandbox.status === SandboxStatus.Restarting && runtime.status === 'Running') {
      finalStatus = SandboxStatus.Running;
    }

    // Updating → Running when update completes (both T13 success and T14 rollback)
    if (sandbox.status === SandboxStatus.Updating && runtime.status === 'Running') {
      finalStatus = SandboxStatus.Running;
    }

    // Pending → Running for async init completion after restart
    if (sandbox.status === SandboxStatus.Pending && runtime.status === 'Running') {
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
      ...(runtime.ephemeralStorageGiB !== undefined ? { ephemeralStorageGiB: runtime.ephemeralStorageGiB } : {}),
      ...(runtimeInstanceId ? { config: { ...sandbox.config, instanceId: runtimeInstanceId } } : {}),
      updatedAt: Date.now(),
      version: generateVersionId(),
    };

    const newVersion = await this.atomic.set(`${KEY_PREFIX}${id}`, updated, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification during syncRuntime');

    await this.logger.write({
      facility: FACILITY,
      level: KernLevel.DEBUG,
      message: `Sandbox runtime synced (${runtime.status})`,
      metadata: { sandboxId: id, providerStatus: runtime.status, containers: runtime.containers.length },
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
    await this.logger.write({
      facility: FACILITY, level: KernLevel.NOTICE,
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
      sandboxId: id,
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

/**
 * Convert a v2 PodSpec (docker-compose style) to CreateSandboxInput for
 * the SandboxService.provision() path.  This bridges the ContainerGroup
 * template kind into the full sandbox lifecycle (state machine, GC, etc.).
 */
export function podSpecToSandboxInput(spec: {
  name: string;
  region?: string | undefined;
  instanceId?: string | undefined;
  hostname?: string | undefined;
  labels?: Record<string, string> | undefined;
  resources?: { cpu?: string | undefined; memory?: string | undefined } | undefined;
  services: Record<string, {
    image: string;
    command?: string | readonly string[] | undefined;
    environment?: Record<string, string> | undefined;
    ports?: readonly { containerPort: number; hostPort?: number | undefined; protocol?: 'tcp' | 'udp' | undefined }[] | undefined;
    volumes?: readonly { source: string; destination: string; readOnly?: boolean | undefined }[] | undefined;
    resources?: { cpu?: string | undefined; memory?: string | undefined } | undefined;
  }>;
}): CreateSandboxInput {
  const names = Object.keys(spec.services);
  const containers = names.map(name => {
    const svc = spec.services[name]!;
    const args = typeof svc.command === 'string' ? [svc.command] : (svc.command as string[] | undefined);
    const env = svc.environment
      ? Object.entries(svc.environment).map(([k, v]) => ({ name: k, value: v }))
      : undefined;
    const cpu = svc.resources?.cpu ? parseFloat(svc.resources.cpu) : 1;
    const memory = svc.resources?.memory ? parseMemoryString(svc.resources.memory) : 2048;
    return {
      name: `${spec.name}-${name}`,
      image: svc.image,
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
      ...(svc.ports ? { ports: svc.ports.map(p => ({ containerPort: p.containerPort, ...(p.protocol ? { protocol: p.protocol } : {}) })) } : {}),
      resources: { limits: { cpu, memory } },
    };
  });

  const totalCpu = spec.resources?.cpu ? parseFloat(spec.resources.cpu) : containers.reduce((s, c) => s + (c.resources?.limits?.cpu ?? 1), 0);
  const totalMem = spec.resources?.memory ? parseMemoryString(spec.resources.memory) : containers.reduce((s, c) => s + (c.resources?.limits?.memory ?? 2048), 0);

  return {
    name: spec.name,
    region: createRegionId(spec.region ?? 'local'),
    ...(spec.instanceId ? { instanceId: spec.instanceId as InstanceId } : {}),
    resourceSpec: { cpu: totalCpu, memory: totalMem },
    restartPolicy: 'Never',
    containers: containers,
    network: { allocatePublicIp: false },
    ...(spec.labels ? { tags: Object.entries(spec.labels).map(([k, v]) => ({ key: k, value: v })) } : {}),
  };
}

/** Parse memory string like "512Mi" or "1Gi" to MB. */
function parseMemoryString(s: string): number {
  const re = /^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti|k|M|G|T|KB|MB|GB|TB)?$/i;
  const m = re.exec(s);
  if (!m) return 512;
  const num = parseFloat(m[1]!);
  const unit = (m[2] ?? 'M').toLowerCase();
  const multipliers: Record<string, number> = {
    ki: 1 / 1024, k: 1 / 1024, kb: 1 / 1024,
    m: 1, mb: 1, mi: 1, '': 1,
    gi: 1024, g: 1024, gb: 1024,
    ti: 1024 * 1024, t: 1024 * 1024, tb: 1024 * 1024,
  };
  return num * (multipliers[unit] ?? 1);
}

export function toContainerGroupInput(input: CreateSandboxInput): CreateContainerGroupInput {
  return {
    name: sanitizeName(input.name),
    description: input.description,
    region: input.region,
    ...(input.instanceId ? { instanceId: input.instanceId } : {}),
    ...(input.zoneId ? { zoneId: input.zoneId } : {}),
    cpu: input.resourceSpec.cpu,
    memory: Math.max(1, Math.ceil(input.resourceSpec.memory / 1024)), // ECI expects GB, applicator provides MB
    gpu: input.resourceSpec.gpu,
    gpuType: input.resourceSpec.gpuType,
    // spotStrategy moved to providerOverrides.alibaba — provider-specific, not neutral.
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
    network: mapNetwork(mergeNetworkWithExtensions(input)),
    tags: mapTags(input.tags),
    providerOverrides: input.providerOverrides,
  };
}

/** Merge Alibaba-specific network settings from extensions into the standard network config.
 *  NetworkSpec.publicIp/vpc are deprecated in favor of extensions.providerOverrides.alibaba.
 *  Extensions take priority when both are present. */
function mergeNetworkWithExtensions(input: CreateSandboxInput): {
  subnetIds?: readonly string[] | undefined; securityGroupId?: string | undefined;
  allocatePublicIp: boolean; publicIpBandwidth?: number | undefined;
  bandwidth?: any;
} {
  const nw = input.network;
  const ext = (input.providerOverrides)?.alibaba as Record<string, unknown> | undefined;

  // EIP: extensions ONLY. Standard network.publicIp is silently ignored (EIP costs money).
  // VPC: standard network first, extensions as override.
  return {
    allocatePublicIp: ext?.autoCreateEip === true || ext?.autoCreateEip === 'true',
    ...(ext?.eipBandwidth !== undefined
      ? { publicIpBandwidth: Number(ext.eipBandwidth) }
      : {}),
    subnetIds: nw.subnetIds?.length
      ? nw.subnetIds
      : (ext?.vSwitchId ? String(ext.vSwitchId).split(',').map(s => s.trim()) : undefined),
    securityGroupId: nw.securityGroupId ?? ext?.securityGroupId as string | undefined,
    bandwidth: nw.bandwidth,
  };
}

/** Map a Partial<CreateSandboxInput> to Partial<CreateContainerGroupInput> for UpdateContainerGroup.
 *  Only maps fields that are present in the input, leaving everything else undefined. */
function toPartialContainerGroupInput(
  input: Partial<CreateSandboxInput>,
  _existing: CreateSandboxInput,
): Partial<CreateContainerGroupInput> {
  const region = input.region ?? _existing.region;

  return {
    ...(region ? { region } : {}),
    ...(input.name ? { name: sanitizeName(input.name) } : {}),
    ...(input.restartPolicy ? { restartPolicy: input.restartPolicy } : {}),
    ...(input.resourceSpec ? {
      cpu: input.resourceSpec.cpu,
      memory: Math.max(1, Math.ceil(input.resourceSpec.memory / 1024)),
      ...(input.resourceSpec.gpu !== undefined ? { gpu: input.resourceSpec.gpu } : {}),
      ...(input.resourceSpec.gpuType ? { gpuType: input.resourceSpec.gpuType } : {}),
    } : {}),
    ...(input.containers ? {
      containers: input.containers.map(c => ({
        name: c.name, image: c.image,
        ...(c.command ? { command: c.command } : {}),
        ...(c.args ? { args: c.args } : {}),
        ...(c.env ? { env: mapEnvVars(c.env) } : {}),
        ...(c.tty !== undefined ? { tty: c.tty } : {}),
        ...(c.stdin !== undefined ? { stdin: c.stdin } : {}),
        ...(c.imagePullPolicy ? { imagePullPolicy: c.imagePullPolicy } : {}),
        ...(c.resources ? { resources: c.resources } : {}),
        ...(c.livenessProbe ? { livenessProbe: c.livenessProbe } : {}),
        ...(c.readinessProbe ? { readinessProbe: c.readinessProbe } : {}),
        ...(c.startupProbe ? { startupProbe: c.startupProbe } : {}),
        ...(c.ports ? { ports: mapPorts(c.ports) } : {}),
        ...(c.networkMode ? { networkMode: c.networkMode } : {}),
      })),
    } : {}),
    ...(input.volumes ? {
      volumes: mapVolumes(input.volumes.map(v => ({
        id: String(v.id), type: v.type, nfs: v.nfs, disk: v.disk, secret: v.secret,
      }))),
    } : {}),
    ...(input.network ? {
      network: mapNetwork({
        subnetIds: input.network.subnetIds ?? _existing.network.subnetIds,
        securityGroupId: input.network.securityGroupId ?? _existing.network.securityGroupId,
        allocatePublicIp: input.network.allocatePublicIp ?? _existing.network.allocatePublicIp,
        publicIpBandwidth: input.network.publicIpBandwidth ?? _existing.network.publicIpBandwidth,
        bandwidth: input.network.bandwidth ?? _existing.network.bandwidth,
      }),
    } : {}),
    ...(input.tags ? { tags: mapTags(input.tags) } : {}),
    ...(input.providerOverrides ? { providerOverrides: input.providerOverrides } : {}),
    ...(input.zoneId ? { zoneId: input.zoneId } : {}),
  };
}

function mapProviderStatus(providerStatus: ContainerGroupRuntime['status']): SandboxStatus | null {
  switch (providerStatus) {
    case 'Running': return null;
    case 'Failed':
    case 'ScheduleFailed': return SandboxStatus.Failed;
    case 'Expired':
    case 'Expiring': return SandboxStatus.Expired;
    case 'Succeeded': return SandboxStatus.Succeeded;
    case 'Restarting': return null; // transient — resolved by syncRuntime special cases
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

/** Sanitize sandbox name for provider API constraints.
 *  Alibaba ECI: [a-zA-Z][a-zA-Z0-9]{1,62} — letters + digits only, no hyphens. */
function sanitizeName(name: string): string {
  let s = name.replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 63);
  if (!s || s.length < 2) s = 'sbx' + Date.now().toString(36);
  if (!/^[a-zA-Z]/.test(s)) s = 's' + s;
  return s;
}
