/**
 * PodService — full lifecycle management for Pods.
 * Mirrors SandboxService but operates on PodSpec/PodPhase/PodEntity.
 */

import type { IAtomicStore } from '../store/interfaces.ts';
import type { IContainerProvider, IProviderRegistry, ContainerLogResult } from '../provider/interfaces.ts';
import { ProviderResolutionError } from '../provider/errors.ts';
import type { CreateContainerGroupInput, ContainerGroupRuntime } from '../provider/types.ts';
import { ContainerGroupState } from '../provider/container-lifecycle.ts';
import { createRegionId } from '../region/types.ts';
import { AppError } from '../types.ts';
import { PodStore } from './store.ts';
import type { PodSpec, PodPhase, PodEntity, PodId, ContainerState, PodHealth } from './types.ts';
import type { IAuditWriter } from '../audit/types.ts';
import { KernLevel } from '../audit/kern-level.ts';
import type { EventBus } from '../event-bus/bus.ts';
import { createEvent } from '../event-bus/types.ts';
import type { QuotaService } from '../quota/service.ts';
import { transitionPod, createPod } from './transitions.ts';
import { buildPodCreateParams } from '../../providers/alibaba/eci-codec.ts';
import { AlibabaOverridesSchema } from './schema.ts';

/** Context passed to PodService.provision() for sandbox-level concerns. */
export interface ProvisionContext {
  readonly creatorId?: string | undefined;
  readonly templateRef?: string | undefined;
}

// ═══════════════════════════════════════════════════════════════
// v2 Provider runtime → PodEntity helpers.
// ═══════════════════════════════════════════════════════════════

function toPodPhase(cgStatus: ContainerGroupState): PodPhase {
  switch (cgStatus) {
    case ContainerGroupState.Scheduling:
    case ContainerGroupState.ScheduleFailed:
    case ContainerGroupState.Pending:
      return 'Pending';
    case ContainerGroupState.Running:
    case ContainerGroupState.Restarting:
    case ContainerGroupState.Updating:
    case ContainerGroupState.Terminating:
      return 'Running';
    case ContainerGroupState.Succeeded:
    case ContainerGroupState.Stopped:
    case ContainerGroupState.Paused:
      return 'Succeeded';
    case ContainerGroupState.Failed:
    case ContainerGroupState.Expired:
      return 'Failed';
    case ContainerGroupState.Deleted:
      return 'Failed';
  }
}

function toContainers(cg: ContainerGroupRuntime): PodEntity['containers'] {
  return cg.containers.map(c => ({
    name: c.name,
    image: c.image,
    state: buildContainerState(c.status, c),
    env: c.env,
    ports: c.network?.ports.map(p => ({ containerPort: p.containerPort, hostPort: p.hostPort ?? undefined, protocol: p.protocol })),
    resources: c.resources ? { cpu: c.resources.cpu, memory: c.resources.memory, gpu: c.resources.gpu } : undefined,
    labels: c.labels,
    annotations: c.annotations,
    mounts: c.mounts,
  }));
}

function buildContainerState(status: string, c: { exitCode?: number | undefined; startedAt?: string | undefined; finishedAt?: string | undefined }): ContainerState {
  const s = status.toLowerCase();
  if (s === 'running') return { state: 'Running', startedAt: c.startedAt ?? '' };
  if (s === 'exited' || s === 'terminated') return { state: 'Terminated', exitCode: c.exitCode ?? 0, reason: undefined, signal: undefined, startedAt: c.startedAt, finishedAt: c.finishedAt };
  return { state: 'Waiting' };
}

// ═══════════════════════════════════════════════════════════════
// PodService
// ═══════════════════════════════════════════════════════════════

export class PodService {
  private readonly store: PodStore;

  public constructor(
    atomic: IAtomicStore,
    private readonly providerRegistry?: IProviderRegistry | undefined,
    /** Fallback provider when no registry is available. */
    private readonly fallbackProvider?: IContainerProvider | undefined,
    private readonly audit?: IAuditWriter | undefined,
    private readonly eventBus?: EventBus | undefined,
    private readonly quotaService?: QuotaService | undefined,
  ) {
    this.store = new PodStore(atomic);
  }

  private async resolveProvider(): Promise<IContainerProvider> {
    if (this.providerRegistry?.resolveContainer) {
      const p = await this.providerRegistry.resolveContainer(undefined);
      return p;
    }
    if (this.fallbackProvider) return this.fallbackProvider;
    throw new ProviderResolutionError('No container provider available for PodService');
  }

  public async provision(spec: PodSpec, context?: ProvisionContext): Promise<PodEntity> {
    const cpu = spec.spec.containers.reduce((s, c) => s + (c.resources?.limits?.cpu ?? 0), 0) || 1;
    const memory = spec.spec.containers.reduce((s, c) => s + (c.resources?.limits?.memory ?? 0), 0) || 512;

    if (context?.creatorId && this.quotaService) {
      await this.quotaService.checkQuota(context.creatorId, cpu, memory);
    }

    const provider = await this.resolveProvider();
    const ali = AlibabaOverridesSchema.parse(spec.providerOverrides?.alibaba ?? {});
    const aliRegion = ali.region ?? 'cn-hangzhou';
    const groupInput: CreateContainerGroupInput = {
      name: spec.metadata.name,
      region: createRegionId(aliRegion),
      cpu,
      memory,
      restartPolicy: spec.spec.restartPolicy,
      containers: spec.spec.containers.map(c => {
        const cc: import('../provider/types.ts').ContainerCreateConfig = {
          name: c.name,
          image: c.image,
          ...(c.command !== undefined ? { command: c.command } : {}),
          ...(c.args !== undefined ? { args: c.args } : {}),
          ...(c.env !== undefined ? { env: c.env } : {}),
          ...(c.ports !== undefined ? { ports: c.ports } : {}),
          ...(c.volumeMounts !== undefined ? { volumeMounts: c.volumeMounts } : {}),
          ...(c.livenessProbe !== undefined ? { livenessProbe: c.livenessProbe } : {}),
          ...(c.readinessProbe !== undefined ? { readinessProbe: c.readinessProbe } : {}),
          ...(c.startupProbe !== undefined ? { startupProbe: c.startupProbe } : {}),
          ...(c.imagePullPolicy !== undefined ? { imagePullPolicy: c.imagePullPolicy } : {}),
          ...(c.tty !== undefined ? { tty: c.tty } : {}),
          ...(c.stdin !== undefined ? { stdin: c.stdin } : {}),
          ...(c.networkMode !== undefined ? { networkMode: c.networkMode } : {}),
          ...(c.providerOverrides !== undefined ? { providerOverrides: c.providerOverrides } : {}),
          ...(c.resources !== undefined ? { resources: { limits: { cpu: c.resources.limits?.cpu ?? 0, memory: c.resources.limits?.memory ?? 0, ...(c.resources.limits?.gpu !== undefined ? { gpu: c.resources.limits.gpu } : {}) } } } : {}),
        };
        return cc;
      }),
      volumes: spec.spec.volumes?.map(v => ({ id: v.id, type: v.type, options: v.options })),
      secretMounts: spec.spec.secretMounts,
      secretRefs: spec.spec.secretRefs,
      resolvedSecrets: spec.spec.resolvedSecrets,
      network: { allocatePublicIp: false },
      tags: spec.metadata.labels ? Object.entries(spec.metadata.labels).map(([k, v]) => ({ key: k, value: v })) : undefined,
      providerOverrides: spec.providerOverrides,
    };
    const { providerId } = await provider.create(groupInput);

    const pod = createPod({
      type: 'Provision',
      spec,
      providerId,
      network: {},
      creatorId: context?.creatorId,
      templateRef: context?.templateRef,
    });

    const written = await this.store.insert(pod);
    if (!written) throw new AppError(500, 'CREATE_FAILED', 'Failed to persist Pod');
    await this.store.addToIndex(pod.podId);

    if (context?.creatorId && this.quotaService) {
      void this.quotaService.recordCreate(context.creatorId, cpu, memory);
    }

    this.audit?.write({
      level: KernLevel.NOTICE, facility: 'pod-service',
      message: `Pod provisioned — ${spec.metadata.name}`,
      actorId: context?.creatorId,
      metadata: { eventType: 'pod.provisioned', podId: pod.podId, providerId },
    });
    void this.eventBus?.dispatch(createEvent('pod.provisioned', {
      podId: pod.podId, name: spec.metadata.name, phase: pod.phase,
      creatorId: context?.creatorId, providerId,
    }));

    return pod;
  }

  public async getById(podId: PodId): Promise<PodEntity | null> {
    return this.store.getById(podId);
  }

  public async list(phase?: PodPhase, limit = 50, cursor?: string): Promise<{ items: PodEntity[]; nextCursor?: string }> {
    return this.store.list(phase, limit, cursor);
  }

  public async stop(podId: PodId): Promise<PodEntity> {
    const pod = await this.store.getById(podId);
    if (!pod) throw new AppError(404, 'POD_NOT_FOUND', `Pod ${podId} not found`);
    if (pod.providerId) {
      const provider = await this.resolveProvider();
      try { await provider.stop?.(pod.providerId); } catch { /* best-effort */ }
    }
    const updated = transitionPod(pod, { type: 'Stop' });
    const result = await this.store.update(podId, updated, pod.version);
    this.audit?.write({
      level: KernLevel.INFO, facility: 'pod-service',
      message: `Pod stopped — ${pod.name}`,
      actorId: pod.creatorId,
      metadata: { eventType: 'pod.stop', podId, fromPhase: pod.phase, toPhase: 'Succeeded' },
    });
    void this.eventBus?.dispatch(createEvent('pod.status', {
      podId, fromPhase: pod.phase, toPhase: 'Succeeded', reason: 'user requested stop',
    }));
    return result;
  }

  public async start(podId: PodId): Promise<PodEntity> {
    const pod = await this.store.getById(podId);
    if (!pod) throw new AppError(404, 'POD_NOT_FOUND', `Pod ${podId} not found`);
    const updated = transitionPod(pod, { type: 'Start' });
    if (pod.providerId) {
      const provider = await this.resolveProvider();
      try { await provider.start?.(pod.providerId); } catch { /* best-effort */ }
    }
    const result = await this.store.update(podId, updated, pod.version);
    this.audit?.write({
      level: KernLevel.INFO, facility: 'pod-service',
      message: `Pod started — ${pod.name}`,
      actorId: pod.creatorId,
      metadata: { eventType: 'pod.start', podId, fromPhase: pod.phase, toPhase: 'Running' },
    });
    void this.eventBus?.dispatch(createEvent('pod.status', {
      podId, fromPhase: pod.phase, toPhase: 'Running', reason: 'user requested start',
    }));
    return result;
  }

  public async restart(podId: PodId): Promise<PodEntity> {
    const pod = await this.store.getById(podId);
    if (!pod) throw new AppError(404, 'POD_NOT_FOUND', `Pod ${podId} not found`);
    const updated = transitionPod(pod, { type: 'Restart' });
    if (pod.providerId) {
      const provider = await this.resolveProvider();
      try { await provider.restart?.(pod.providerId); } catch { /* best-effort */ }
    }
    const result = await this.store.update(podId, updated, pod.version);
    this.audit?.write({
      level: KernLevel.INFO, facility: 'pod-service',
      message: `Pod restarted — ${pod.name}`,
      actorId: pod.creatorId,
      metadata: { eventType: 'pod.restart', podId },
    });
    void this.eventBus?.dispatch(createEvent('pod.status', {
      podId, fromPhase: pod.phase, toPhase: pod.phase, reason: 'user requested restart',
    }));
    return result;
  }

  public async getHealth(podId: PodId): Promise<readonly PodHealth[]> {
    const pod = await this.store.getById(podId);
    if (!pod) throw new AppError(404, 'POD_NOT_FOUND', `Pod ${podId} not found`);

    // Try sync for Running pods to get fresh container state
    if (pod.phase === 'Running' && pod.providerId) {
      try { await this.syncRuntime(podId); } catch {
        /* stale OK */
      }
    }

    const current = (await this.store.getById(podId)) ?? pod;

    // Non-Running/Pending pods: all containers stopped
    if (current.phase !== 'Running' && current.phase !== 'Pending') {
      return current.containers.map(c => ({
        containerName: c.name,
        status: 'stopped',
        ready: false,
        startedAt: c.state.state === 'Running' ? c.state.startedAt : undefined,
        message: `Pod is in ${current.phase} phase`,
      }));
    }

    // Running/Pending: derive from cached container state
    return current.containers.map(c => {
      const st = c.state;
      switch (st.state) {
        case 'Running':
          return { containerName: c.name, status: 'running', ready: true, startedAt: st.startedAt, message: undefined };
        case 'Waiting':
          return { containerName: c.name, status: 'starting', ready: false, startedAt: undefined, message: st.reason };
        case 'Terminated':
          return { containerName: c.name, status: 'stopped', ready: false, startedAt: st.startedAt, message: st.reason };
      }
    });
  }

  public async terminate(podId: PodId): Promise<void> {
    const pod = await this.store.getById(podId);
    if (!pod) throw new AppError(404, 'POD_NOT_FOUND', `Pod ${podId} not found`);

    // Step 1: mark Terminate (set deletionTimestamp + DisruptionTarget)
    const marked = transitionPod(pod, { type: 'Terminate' });
    const saved = await this.store.update(podId, marked, pod.version);

    // Step 2: delete provider resource (best-effort)
    if (pod.providerId) {
      const provider = await this.resolveProvider();
      try {
        await provider.delete({ region: createRegionId('cn-hangzhou'), providerId: pod.providerId });
      } catch { /* GC will retry */ }
    }

    // Step 3: mark final state — use saved.version (atomic version) for OCC
    const terminated = transitionPod(saved, { type: 'MarkFailed', reason: 'user requested termination' });
    await this.store.update(podId, terminated, saved.version);
    await this.store.removeFromIndex(podId);

    // quota release
    if (pod.creatorId && this.quotaService) {
      const cpu = pod.spec.spec.containers.reduce((s, c) => s + (c.resources?.limits?.cpu ?? 0), 0) || 1;
      const memory = pod.spec.spec.containers.reduce((s, c) => s + (c.resources?.limits?.memory ?? 0), 0) || 512;
      void this.quotaService.recordDelete(pod.creatorId, cpu, memory);
    }

    this.audit?.write({
      level: KernLevel.WARNING, facility: 'pod-service',
      message: `Pod terminated — ${pod.name}`,
      actorId: pod.creatorId,
      metadata: { eventType: 'pod.terminated', podId },
    });
    void this.eventBus?.dispatch(createEvent('pod.status', {
      podId, fromPhase: pod.phase, toPhase: 'Failed', reason: 'user requested termination',
    }));
  }

  public async getAllIds(): Promise<string[]> {
    return this.store.getAllIds();
  }

  /** GC cleanup — delete provider resource (best-effort) + remove from index. */
  public async gcCleanup(podId: PodId): Promise<void> {
    const pod = await this.store.getById(podId);
    if (!pod) return;

    const providerStatus = pod.providerId ? await this.checkProviderStatus(podId) : null;

    if (providerStatus === null && pod.providerId) {
      // Provider resource is gone — force delete
      const updated = transitionPod(pod, { type: 'ForceDelete' });
      await this.store.update(podId, updated, pod.version);
      await this.store.removeFromIndex(podId);
      return;
    }

    const duration = Date.now() - pod.createdAt;
    if (pod.phase === 'Succeeded' || pod.phase === 'Failed') {
      if (duration > 60_000) {
        if (pod.phase === 'Succeeded') {
          const updated = transitionPod(pod, { type: 'MarkSucceeded' });
          if (pod.providerId) {
            const provider = await this.resolveProvider();
            try { await provider.delete({ region: createRegionId('cn-hangzhou'), providerId: pod.providerId }); } catch { }
          }
          await this.store.update(podId, updated, pod.version);
        } else {
          const updated = transitionPod(pod, { type: 'MarkFailed', reason: 'GC cleanup' });
          if (pod.providerId) {
            const provider = await this.resolveProvider();
            try { await provider.delete({ region: createRegionId('cn-hangzhou'), providerId: pod.providerId }); } catch { }
          }
          await this.store.update(podId, updated, pod.version);
        }
        await this.store.removeFromIndex(podId);
      }
      return;
    }

    if (pod.deletionTimestamp && duration > 60_000) {
      if (pod.providerId) {
        const provider = await this.resolveProvider();
        try { await provider.delete({ region: createRegionId('cn-hangzhou'), providerId: pod.providerId }); } catch { return; }
      }
      const updated = transitionPod(pod, { type: 'ForceDelete' });
      await this.store.update(podId, updated, pod.version);
      await this.store.removeFromIndex(podId);
    }
  }

  /** Lightweight provider status check — returns runtime or null if resource is gone. */
  public async checkProviderStatus(podId: PodId): Promise<ContainerGroupRuntime | null> {
    const pod = await this.store.getById(podId);
    if (!pod?.providerId) return null;
    const provider = await this.resolveProvider();
    if (!provider.getStatus) return null;
    let providerStatus: ContainerGroupRuntime | null = null;
    try {
      providerStatus = await provider.getStatus(pod.providerId);
    } catch (_e) {
      /* provider unreachable — treat as resource gone */
    }
    return providerStatus;
  }

  public async syncRuntime(podId: PodId): Promise<PodEntity> {
    const pod = await this.store.getById(podId);
    if (!pod?.providerId) throw new AppError(404, 'POD_NOT_FOUND', `Pod ${podId} not found or has no providerId`);
    const provider = await this.resolveProvider();
    const describeResult = await provider.describe({ region: createRegionId('cn-hangzhou'), sandboxId: pod.providerId });
    const runtime = describeResult.sandboxes[0];
    if (!runtime) throw new AppError(404, 'RUNTIME_NOT_FOUND', `No runtime found for pod ${podId}`);

    const podRuntime: import('./types.ts').PodRuntime = {
      podId, providerId: pod.providerId, name: pod.name,
      phase: toPodPhase(runtime.status),
      conditions: [],
      containers: toContainers(runtime),
      volumes: runtime.volumes?.map(v => ({ name: v.name ?? '', type: v.type ?? '' })) ?? [],
      events: runtime.events?.map(e => ({ reason: e.reason, type: e.type, message: e.message, count: e.count })) ?? [],
      network: { privateIp: runtime.network.privateIp, ...(runtime.network.vpcId ? { vpcId: runtime.network.vpcId } : {}), ...(runtime.network.subnetId ? { subnetId: runtime.network.subnetId } : {}), ...(runtime.network.securityGroupId ? { securityGroupId: runtime.network.securityGroupId } : {}) },
    };

    const updated = transitionPod(pod, { type: 'UpdateFromProvider', status: podRuntime });
    const result = await this.store.update(podId, updated, pod.version);

    this.audit?.write({
      level: KernLevel.DEBUG, facility: 'pod-service',
      message: `Pod runtime synced (${runtime.status})`,
      metadata: { eventType: 'pod.sync', podId, providerStatus: runtime.status, containers: runtime.containers.length },
    });
    return result;
  }

  public async getLogs(podId: PodId, containerName: string, options?: { limitBytes?: number; sinceSeconds?: number; timestamps?: boolean }): Promise<ContainerLogResult> {
    const pod = await this.store.getById(podId);
    if (!pod?.providerId) throw new AppError(404, 'POD_NOT_FOUND', `Pod ${podId} not found or has no providerId`);
    const provider = await this.resolveProvider();
    return provider.getLogs({ region: createRegionId('cn-hangzhou'), providerId: pod.providerId, containerName, ...options });
  }

  public async exec(podId: PodId, cmd: readonly string[], containerName?: string): Promise<{ execId: string; webSocketUri?: string | undefined }> {
    const pod = await this.store.getById(podId);
    if (!pod?.providerId) throw new AppError(404, 'POD_NOT_FOUND', `Pod ${podId} not found or has no providerId`);
    const provider = await this.resolveProvider();
    if (!provider.exec) throw new AppError(501, 'NOT_IMPLEMENTED', 'Provider does not support exec');
    const result = await provider.exec(pod.providerId, cmd, containerName);
    return { execId: result.execId, webSocketUri: result.webSocketUri ?? undefined };
  }

  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- PodSpec has many fields
  public async update(podId: PodId, specPatch: Record<string, unknown>): Promise<PodEntity> {
    const pod = await this.store.getById(podId);
    if (!pod) throw new AppError(404, 'POD_NOT_FOUND', `Pod ${podId} not found`);

    const mergedSpec: PodSpec = {
      metadata: { ...pod.spec.metadata, ...((specPatch.metadata as Record<string, unknown>) ?? {}) },
      spec: {
        containers: ((specPatch.spec as Record<string, unknown>)?.containers as readonly import('./types.ts').ContainerSpec[]) ?? pod.spec.spec.containers,
        restartPolicy: ((specPatch.spec as Record<string, unknown | undefined>)?.restartPolicy as 'Always' | 'OnFailure' | 'Never') ?? pod.spec.spec.restartPolicy,
      },
      providerOverrides: { ...pod.spec.providerOverrides, ...((specPatch.providerOverrides as Record<string, unknown>) ?? {}) },
    } satisfies PodSpec;

    const updated = transitionPod(pod, { type: 'Update', spec: mergedSpec });

    if (pod.providerId) {
      const provider = await this.resolveProvider();
      if (provider.update) {
        try { await provider.update(pod.providerId, buildPodCreateParams(mergedSpec, 'cn-hangzhou')); } catch { /* best-effort */ }
      }
    }

    return this.store.update(podId, updated, pod.version);
  }
}
