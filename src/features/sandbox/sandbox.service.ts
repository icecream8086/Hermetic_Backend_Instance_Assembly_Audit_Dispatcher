import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type {
  IContainerProvider,
  IProviderRegistry,
  ContainerGroupRuntime,
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
  ContainerRuntime,
  ContainerEvent,
} from './types.ts';
import type {
  ISandboxService,
  ContainerHealth,
} from './interfaces.ts';
import { KernLevel } from '../../core/audit/kern-level.ts';
import { createFacility, generateVersionId } from '../../core/brand.ts';
import { createRegionId } from '../../core/region/types.ts';
import { createInstanceId } from '../../core/region/instance.ts';
import { ContainerGroupState, toSandboxStatus } from '../../core/provider/container-lifecycle.ts';
import type { PodService } from '../../core/pod/service.ts';
import { createPodId, type PodSpec } from '../../core/pod/types.ts';
import { AppError } from '../../core/types.ts';
import { ProviderResolutionError, ProviderOperationError } from '../../core/provider/errors.ts';
import type { EventBus } from '../../core/event-bus/bus.ts';
import { createEvent } from '../../core/event-bus/types.ts';
import type { NetworkResolverFn } from '../../core/network/types.ts';
import type { InstanceService } from '../../core/region/instance.ts';
import type { IMessageQueue } from '../../queue/interfaces.ts';
import { SandboxStore } from './sandbox-store.ts';
import { runtimeToNetwork, runtimeToContainers, runtimeToEvents } from './runtime-mapper.ts';
import { z } from 'zod';

const FACILITY = createFacility('sandbox-service');
const KEY_PREFIX = 'sandbox:';
// ─── Service ───

export class SandboxService implements ISandboxService {
  private readonly store: SandboxStore;

  public constructor(
    private readonly atomic: IAtomicStore,
    private readonly logger: IAuditWriter,
    /** PodService for unified lifecycle. All compute operations delegate here. */
    private readonly podService: PodService,
    private readonly providerRegistry?: IProviderRegistry | undefined,
    private readonly eventBus?: EventBus,
    private readonly audit?: IAuditWriter,
    private readonly resolveNetwork?: NetworkResolverFn | undefined,
    private readonly instanceService?: InstanceService | undefined,
    private readonly queueProducer?: IMessageQueue,
  ) {
    this.store = new SandboxStore(atomic);
  }

  async #enqueueGcRetry(id: string, sandbox: Sandbox): Promise<void> {
    if (!this.queueProducer?.sendSandboxGc) return;
    try {
      await this.queueProducer.sendSandboxGc({
        sandboxId: id,
        reason: 'manual',
        providerId: sandbox.providerId ?? id,
        region: sandbox.config.region,
        ...(sandbox.config.instanceId ? { instanceId: sandbox.config.instanceId } : {}),
        containerCount: sandbox.containers.length,
        sandboxName: sandbox.name,
        createdAt: sandbox.createdAt,
      });
    } catch {

      console.debug("fire-and-forget: queue may be unavailable");

    }
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
      const p = await this.providerRegistry.resolveContainer(createInstanceId(instanceId));
      return p;
    }
    // No instanceId and no global default — pick first online instance
    if (this.providerRegistry?.resolveContainer) {
      const p = await this.providerRegistry.resolveContainer(undefined);
      return p;
    }
    throw new ProviderResolutionError(
      'Cannot resolve provider: no instanceId specified and no global default configured. Pass an explicit instanceId or ensure an online container-capable instance is registered.',
    );
  }

  public async provision(input: CreateSandboxInput, idempotencyKey?: string): Promise<Sandbox> {
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
      zoneId: resolvedInst.zone,
      credentialRef: resolvedInst.credentialRef,
    } : undefined;

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
      containers: new Array<ContainerRuntime>(),
      events: new Array<ContainerEvent>(),
    };

    const created = await this.atomic.set<Sandbox>(`${KEY_PREFIX}${id}`, initial, null);
    if (!created) throw new AppError(500, 'CREATE_FAILED', 'Failed to persist initial sandbox state');

    // Add to sandbox ID index
    await this.store.addToIndex(id);

    // 2. Auto-generate S3 access keys for buckets with autoGenerateKeys (binding persistence)
    const BINDING_PREFIX = 'bucket-key:';
    const BINDING_INDEX_KEY = 'bucket-key:ids';
    if (input.bucketMounts?.length) {
      for (const bm of input.bucketMounts) {
        if (!bm.autoGenerateKeys) continue;
        const ak = `auto_${crypto.randomUUID().slice(0, 12)}`;
        const sk = Array.from(crypto.getRandomValues(new Uint8Array(32)))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');
        const secretValue = `${ak}:${sk}`;
        const binding = {
          sandboxId: id,
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
        await this.atomic.set(BINDING_INDEX_KEY, [...(idx_?.value ?? []), id], idx_?.version ?? null);
      }
    }

    // ── Delegate to PodService (v3 unified lifecycle) ──
    let providerId: string;
    let podId: string | undefined;

    const podSpec = toPodSpec(input);
    try {
      const pod = await this.podService.provision(podSpec);
      providerId = pod.providerId ?? id;
      podId = pod.podId;
    } catch (e) {
      try { await this.atomic.set(`${KEY_PREFIX}${id}`, { ...initial, status: SandboxStatus.Failed, updatedAt: Date.now() }, created); } catch {
        /* best-effort cleanup */
        console.debug("best-effort cleanup");
      }
      throw new AppError(502, 'PROVIDER_ERROR', `Cloud provider failed for sandbox "${input.name}": ${e instanceof Error ? e.message : String(e)}`);
    }
    const provisioned: Sandbox = {
      ...initial,
      status: SandboxStatus.Scheduling,
      providerId,
      updatedAt: Date.now(),
      version: generateVersionId(),
      ...(podId ? { podUid: podId } : {}),
    };

    const updated = await this.atomic.set(`${KEY_PREFIX}${id}`, provisioned, created);
    if (!updated) throw new AppError(409, 'CONFLICT', 'Concurrent modification during provision');

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
    void this.eventBus?.dispatch(createEvent('sandbox.provisioned', {
      sandboxId: id,
      status: SandboxStatus.Running,
      name: input.name,
      creatorId: input.creatorId,
      providerId,
    }));

    return provisioned;
  }

  public async getById(id: SandboxId): Promise<Sandbox | null> {
    return this.store.getById(id);
  }

  public async list(status?: SandboxStatus, limit = 50, cursor?: string): Promise<{ items: Sandbox[]; nextCursor?: string }> {
    return this.store.list(status, limit, cursor);
  }

  public async stop(id: SandboxId): Promise<Sandbox> {
    const sandbox = await this.getById(id);
    if (!sandbox) throw new AppError(404, 'SANDBOX_NOT_FOUND', `Sandbox ${id} not found`);

    if (sandbox.podUid) {
      await this.podService.stop(createPodId(sandbox.podUid));
    }

    return this.transition(id, SandboxStatus.Succeeded, 'user requested stop');
  }

  public async start(id: SandboxId): Promise<Sandbox> {
    const sandbox = await this.getById(id);
    if (!sandbox) throw new AppError(404, 'SANDBOX_NOT_FOUND', `Sandbox ${id} not found`);

    if (sandbox.podUid) {
      await this.podService.start(createPodId(sandbox.podUid));
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
  public async terminate(id: SandboxId, actorId?: string): Promise<void> {
    const sandbox = await this.getById(id);
    if (!sandbox) throw new AppError(404, 'SANDBOX_NOT_FOUND', `Sandbox ${id} not found`);

    // Idempotent: already deleted
    if (sandbox.status === SandboxStatus.Deleted) return;

    // Already terminating — re-trigger cleanup for safety, then return
    if (sandbox.status === SandboxStatus.Terminating) {
      if (sandbox.podUid) {
        await this.podService.terminate(createPodId(sandbox.podUid));
      } else if (sandbox.providerId) {
        try {
          const provider = await this.#resolveProvider(sandbox.config.instanceId);
          await provider.delete({ region: sandbox.config.region, providerId: sandbox.providerId });
        } catch {

          console.debug("GC will retry");

        }
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

    // PodService delegation: let PodService handle provider-level cleanup
    if (sandbox.podUid) {
      await this.podService.terminate(createPodId(sandbox.podUid));
      await this.transition(id, SandboxStatus.Deleted, 'user requested termination', actorId);
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
        void this.#enqueueGcRetry(id, sandbox);
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

  public async forceTransition(id: SandboxId, to: SandboxStatus, reason: string, actorId?: string): Promise<Sandbox> {
    return this.transition(id, to, reason, actorId);
  }

  public async pollForIp(sandboxId: SandboxId, timeoutMs: number, pollIntervalMs: number): Promise<string | null> {
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

  public async getHealth(id: SandboxId): Promise<readonly ContainerHealth[]> {
    const sandbox = await this.getById(id);
    if (!sandbox) throw new AppError(404, 'SANDBOX_NOT_FOUND', `Sandbox ${id} not found`);

    if (sandbox.podUid) {
      const podHealth = await this.podService.getHealth(createPodId(sandbox.podUid));
      return podHealth.map(h => ({
        containerName: h.containerName,
        status: h.status,
        ready: h.ready,
        startedAt: h.startedAt,
        message: h.message,
      }));
    }

    // Fallback (unreachable once podService is required in Phase F)
    throw new AppError(501, 'NOT_IMPLEMENTED', 'getHealth requires PodService');
  }

	  public async restart(id: SandboxId): Promise<Sandbox> {
	    const sandbox = await this.getById(id);
	    if (!sandbox) throw new AppError(404, 'SANDBOX_NOT_FOUND', `Sandbox ${id} not found`);

	    if (sandbox.status !== SandboxStatus.Running) {
	      throw new AppError(409, 'RESTART_NOT_ALLOWED', `Cannot restart sandbox in ${sandbox.status} state — only Running is valid`);
	    }

	    await this.transition(id, SandboxStatus.Restarting, 'user requested restart');

	    if (sandbox.podUid) {
	      await this.podService.restart(createPodId(sandbox.podUid));
	    }

	    return (await this.getById(id)) ?? sandbox;
	  }

	  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- sandbox update spec: input fields are naturally optional
  public async update(id: SandboxId, input: Partial<CreateSandboxInput>): Promise<Sandbox> {
	    const sandbox = await this.getById(id);
	    if (!sandbox) throw new AppError(404, 'SANDBOX_NOT_FOUND', `Sandbox ${id} not found`);

	    if (sandbox.status !== SandboxStatus.Running) {
	      throw new AppError(409, 'UPDATE_NOT_ALLOWED', `Cannot update sandbox in ${sandbox.status} state`);
	    }

	    if (sandbox.podUid) {
	      const specPatch = partialInputToPodSpecPatch(input);
	      await this.podService.update(createPodId(sandbox.podUid), specPatch);
	    }

	    await this.transition(id, SandboxStatus.Updating, 'user requested update');

	    // Config merge always runs for sandbox state
	    if (Object.keys(input).length > 0) {
	      const entry = await this.atomic.get<Sandbox>(`${KEY_PREFIX}${id}`);
	      if (entry) {
	        const mergedConfig = { ...entry.value.config, ...input, network: { ...entry.value.config.network, ...(input.network ?? {}) } };
	        const updated: Sandbox = { ...entry.value, config: mergedConfig, updatedAt: Date.now(), version: generateVersionId() };
	        await this.atomic.set(`${KEY_PREFIX}${id}`, updated, entry.version);
	      }
	    }

	    return (await this.getById(id)) ?? sandbox;
	  }

	  public async syncRuntime(id: SandboxId): Promise<ContainerGroupRuntime> {
    // Single read — reuse its version for OCC at write time, avoiding a redundant
    // second read before the set() below.
    const entry = await this.atomic.get<Sandbox>(`${KEY_PREFIX}${id}`);
    if (!entry) throw new AppError(404, 'SANDBOX_NOT_FOUND', `Sandbox ${id} not found`);
    const sandbox = entry.value;

    // Delegate Pod sync when PodService is available
    if (sandbox.podUid) {
      await this.podService.syncRuntime(createPodId(sandbox.podUid));
    }

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

    const mapped = toSandboxStatus(runtime.status);
    let finalStatus = mapped !== sandbox.status && isValidTransition(sandbox.status, mapped)
      ? mapped
      : sandbox.status;

    // Transient → Running convergence (provider confirms Running before SandboxStatus caught up)
    if (runtime.status === ContainerGroupState.Running) {
      if (sandbox.status === SandboxStatus.Scheduling || sandbox.status === SandboxStatus.Pending) {
        finalStatus = SandboxStatus.Running;
      } else if (sandbox.status === SandboxStatus.Restarting || sandbox.status === SandboxStatus.Updating) {
        finalStatus = SandboxStatus.Running;
      }
    }

    // Terminating → Deleted when provider confirms cleanup (T15)
    if (sandbox.status === SandboxStatus.Terminating && runtime.status === ContainerGroupState.Deleted) {
      finalStatus = SandboxStatus.Deleted;
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
      sandboxId: id,
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
      message: `sandbox ${fromStatus}→${to} name=${sandbox.name} provider=${sandbox.providerId ?? ''} containers=${String(sandbox.containers.length)} uptime=${String(uptime)}ms reason=${reason}`,
      actorId,
      metadata: meta,
    });
    this.audit?.write({
      level: KernLevel.INFO, facility: FACILITY,
      message: `Sandbox ${fromStatus} → ${to} — ${reason}`,
      actorId,
      metadata: meta,
    });

    void this.eventBus?.dispatch(createEvent('sandbox.status', {
      sandboxId: id,
      fromStatus,
      toStatus: to,
      reason,
    }));

    return updated;
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
    let args: string[] | undefined;
    try { z.string().parse(svc.command); args = [svc.command]; } catch {
      if (svc.command !== undefined) args = [...svc.command];
    }
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

  const totalCpu = spec.resources?.cpu ? parseFloat(spec.resources.cpu) : containers.reduce((s, c) => s + c.resources.limits.cpu, 0);
  const totalMem = spec.resources?.memory ? parseMemoryString(spec.resources.memory) : containers.reduce((s, c) => s + c.resources.limits.memory, 0);

  return {
    name: spec.name,
    region: createRegionId(spec.region ?? 'local'),
    ...(spec.instanceId ? { instanceId: createInstanceId(spec.instanceId) } : {}),
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







function toPodSpec(input: CreateSandboxInput): PodSpec {
  return {
    metadata: {
      name: input.name,
      ...(input.tags?.length ? { labels: Object.fromEntries(input.tags.map(t => [t.key, t.value])) } : {}),
    },
    spec: {
      containers: input.containers.map(c => ({
        name: c.name,
        image: c.image,
        command: c.command,
        args: c.args,
        env: c.env,
        resources: c.resources?.limits ? { limits: { cpu: c.resources.limits.cpu, memory: c.resources.limits.memory, ...(c.resources.limits.gpu !== undefined ? { gpu: c.resources.limits.gpu } : {}) } } : undefined,
        ports: c.ports,
        volumeMounts: c.volumeMounts,
        livenessProbe: c.livenessProbe,
        readinessProbe: c.readinessProbe,
        startupProbe: c.startupProbe,
        imagePullPolicy: c.imagePullPolicy,
        tty: c.tty,
        stdin: c.stdin,
        networkMode: c.networkMode,
        providerOverrides: c.providerOverrides,
      })),
      ...(input.initContainers?.length ? {
        initContainers: input.initContainers.map(c => ({
          name: c.name,
          image: c.image,
          command: c.command,
          args: c.args,
          env: c.env,
        })),
      } : {}),
      restartPolicy: input.restartPolicy,
      // volumes: mapped via providerOverrides for now (sandbox Volume entity ≠ PodSpec VolumeSpec)
    },
    ...(input.providerOverrides ? { providerOverrides: input.providerOverrides } : {}),
  };
}

// eslint-disable-next-line @typescript-eslint/no-restricted-types -- partial sandbox input to PodSpec patch
function partialInputToPodSpecPatch(input: Partial<CreateSandboxInput>): Partial<PodSpec> {
  const metadata: PodSpec['metadata'] | undefined = input.name || input.tags?.length
    ? {
        name: input.name ?? '',
        ...(input.tags?.length ? { labels: Object.fromEntries(input.tags.map(t => [t.key, t.value])) } : {}),
      }
    : undefined;
  const containers = input.containers?.length
    ? input.containers.map(c => ({
        name: c.name, image: c.image, command: c.command, args: c.args, env: c.env,
        resources: c.resources?.limits ? { limits: c.resources.limits } : undefined,
        ports: c.ports, volumeMounts: c.volumeMounts,
        livenessProbe: c.livenessProbe, readinessProbe: c.readinessProbe, startupProbe: c.startupProbe,
        imagePullPolicy: c.imagePullPolicy, tty: c.tty, stdin: c.stdin, networkMode: c.networkMode,
        providerOverrides: c.providerOverrides,
      }))
    : undefined;
  const spec: PodSpec['spec'] | undefined = containers || input.restartPolicy
    ? { containers: containers ?? [], restartPolicy: input.restartPolicy ?? 'Always' }
    : undefined;
  return {
    ...(metadata !== undefined ? { metadata } : {}),
    ...(spec !== undefined ? { spec } : {}),
    ...(input.providerOverrides ? { providerOverrides: input.providerOverrides } : {}),
  };
}




