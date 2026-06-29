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
import { generateVersionId } from '../brand.ts';
import { AppError } from '../types.ts';
import { PodStore } from './store.ts';
import type { PodSpec, PodPhase, PodEntity, PodNetwork, PodId, ContainerState } from './types.ts';
import { createPodId } from './types.ts';

// ═══════════════════════════════════════════════════════════════
// Adapters (to be replaced by PodCodec injection)
// ═══════════════════════════════════════════════════════════════

function podSpecToGroupInput(spec: PodSpec): CreateContainerGroupInput {
  const containers = spec.spec.containers.map(c => {
    const cpu = c.resources?.limits?.cpu ?? 0;
    const mem = c.resources?.limits?.memory ?? 0;
    return {
      name: c.name,
      image: c.image,
      command: c.command,
      args: c.args,
      env: c.env,
      ports: c.ports,
      volumeMounts: c.volumeMounts,
      livenessProbe: c.livenessProbe,
      readinessProbe: c.readinessProbe,
      startupProbe: c.startupProbe,
      imagePullPolicy: c.imagePullPolicy ?? undefined,
      tty: c.tty ?? undefined,
      stdin: c.stdin ?? undefined,
      networkMode: c.networkMode ?? undefined,
      resources: (cpu > 0 || mem > 0) ? { limits: { cpu, memory: mem, ...(c.resources?.limits?.gpu !== undefined ? { gpu: c.resources.limits.gpu } : {}) } } : undefined,
    };
  });

  return {
    name: spec.metadata.name,
    region: createRegionId('cn-hangzhou'),
    cpu: containers.reduce((s, c) => s + (c.resources?.limits?.cpu ?? 0), 0) || 1,
    memory: containers.reduce((s, c) => s + (c.resources?.limits?.memory ?? 0), 0) || 512,
    restartPolicy: spec.spec.restartPolicy,
    containers,
    volumes: spec.spec.volumes?.map(v => ({ id: v.id, type: v.type, options: v.options })),
    tags: spec.metadata.labels ? Object.entries(spec.metadata.labels).map(([k, v]) => ({ key: k, value: v })) : undefined,
    network: { allocatePublicIp: false },
    providerOverrides: spec.providerOverrides,
  };
}

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
  ) {
    this.store = new PodStore(atomic);
  }

  private async resolveProvider(): Promise<IContainerProvider> {
    if (this.providerRegistry?.resolveContainer) {
      const p = await this.providerRegistry.resolveContainer(undefined);
      if (p) return p;
    }
    if (this.fallbackProvider) return this.fallbackProvider;
    throw new ProviderResolutionError('No container provider available for PodService');
  }

  public async provision(spec: PodSpec): Promise<PodEntity> {
    const podId = createPodId(crypto.randomUUID());
    const provider = await this.resolveProvider();
    const groupInput = podSpecToGroupInput(spec);
    const { providerId } = await provider.create(groupInput);
    const initialPhase: PodPhase = provider.lifecycle.asyncInit ? 'Pending' : 'Running';

    const entity: PodEntity = {
      podId,
      name: spec.metadata.name,
      spec,
      phase: initialPhase,
      providerId,
      network: {},
      containers: [],
      conditions: [],
      events: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: generateVersionId(),
      creatorId: undefined,
    };

    const written = await this.store.insert(entity);
    if (!written) throw new AppError(500, 'CREATE_FAILED', 'Failed to persist Pod');
    await this.store.addToIndex(podId);
    return entity;
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
    return this.store.transition(podId, 'Succeeded');
  }

  public async start(podId: PodId): Promise<PodEntity> {
    const pod = await this.store.getById(podId);
    if (!pod) throw new AppError(404, 'POD_NOT_FOUND', `Pod ${podId} not found`);
    if (pod.providerId) {
      const provider = await this.resolveProvider();
      try { await provider.start?.(pod.providerId); } catch { /* best-effort */ }
    }
    return this.store.transition(podId, 'Running');
  }

  public async terminate(podId: PodId): Promise<void> {
    const pod = await this.store.getById(podId);
    if (!pod) throw new AppError(404, 'POD_NOT_FOUND', `Pod ${podId} not found`);
    if (pod.providerId) {
      const provider = await this.resolveProvider();
      try { await provider.delete({ region: createRegionId('cn-hangzhou'), providerId: pod.providerId }); } catch { /* GC will retry */ }
    }
    await this.store.transition(podId, 'Failed');
    await this.store.removeFromIndex(podId);
  }

  public async getAllIds(): Promise<string[]> {
    return this.store.getAllIds();
  }

  /** GC cleanup — delete provider resource (best-effort) + remove from index. */
  public async gcCleanup(podId: PodId): Promise<void> {
    const pod = await this.store.getById(podId);
    if (!pod) return;
    if (pod.providerId) {
      const provider = await this.resolveProvider();
      try {
        await Promise.race([
          provider.delete({ region: createRegionId('cn-hangzhou'), providerId: pod.providerId }),
          new Promise<never>((_, reject) => setTimeout(() => { reject(new Error('GC delete timeout after 10s')); }, 10_000)),
        ]);
      } catch { /* best-effort */ }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const latest = await this.store.getById(podId);
      if (!latest) break;
      try {
        await this.store.update(podId, { ...latest, phase: 'Failed', updatedAt: Date.now(), version: generateVersionId() }, latest.version);
      } catch { continue; }
      break;
    }
    await this.store.removeFromIndex(podId);
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
    } catch (_e) { /* provider unreachable — treat as resource gone */ }
    return providerStatus;
  }

  public async syncRuntime(podId: PodId): Promise<PodEntity> {
    const pod = await this.store.getById(podId);
    if (!pod?.providerId) throw new AppError(404, 'POD_NOT_FOUND', `Pod ${podId} not found or has no providerId`);
    const provider = await this.resolveProvider();
    const result = await provider.describe({ region: createRegionId('cn-hangzhou'), sandboxId: pod.providerId });
    const runtime = result.sandboxes[0];
    if (!runtime) throw new AppError(404, 'RUNTIME_NOT_FOUND', `No runtime found for pod ${podId}`);

    const containers = toContainers(runtime);
    const phase = toPodPhase(runtime.status);
    const network: PodNetwork = {
      privateIp: runtime.network.privateIp,
      vpcId: runtime.network.vpcId,
      subnetId: runtime.network.subnetId,
      securityGroupId: runtime.network.securityGroupId,
    };

    const updated: PodEntity = {
      ...pod,
      phase,
      containers,
      network,
      events: runtime.events.map(e => ({ reason: e.reason, type: e.type, message: e.message, count: e.count })),
      updatedAt: Date.now(),
      version: generateVersionId(),
    };
    return this.store.update(podId, updated, pod.version);
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

  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- PodSpec has many fields, Partial avoids maintaining a duplicate PatchSpec type
  public async update(podId: PodId, specPatch: Partial<PodSpec>): Promise<PodEntity> {
    const pod = await this.store.getById(podId);
    if (!pod) throw new AppError(404, 'POD_NOT_FOUND', `Pod ${podId} not found`);
    if (pod.providerId) {
      const provider = await this.resolveProvider();
      if (provider.update) {
        const groupInput = podSpecToGroupInput(mergePodSpec(pod.spec, specPatch));
        try { await provider.update(pod.providerId, groupInput); } catch { /* best-effort */ }
      }
    }
    const merged = mergePodSpec(pod.spec, specPatch);
    const updated: PodEntity = {
      ...pod,
      spec: merged,
      updatedAt: Date.now(),
      version: generateVersionId(),
    };
    return this.store.update(podId, updated, pod.version);
  }
}

// eslint-disable-next-line @typescript-eslint/no-restricted-types -- merge helper: Partial allows sparse overrides over a large spec
function mergePodSpec(base: PodSpec, patch: Partial<PodSpec>): PodSpec {
  return {
    metadata: { ...base.metadata, ...patch.metadata },
    spec: {
      containers: patch.spec?.containers ?? base.spec.containers,
      restartPolicy: patch.spec?.restartPolicy ?? base.spec.restartPolicy,
      ...(base.spec.initContainers || patch.spec?.initContainers ? { initContainers: patch.spec?.initContainers ?? base.spec.initContainers } : {}),
      ...(base.spec.volumes || patch.spec?.volumes ? { volumes: patch.spec?.volumes ?? base.spec.volumes } : {}),
      ...(base.spec.priority !== undefined || patch.spec?.priority !== undefined ? { priority: patch.spec?.priority ?? base.spec.priority } : {}),
      ...(base.spec.nodeSelector || patch.spec?.nodeSelector ? { nodeSelector: patch.spec?.nodeSelector ?? base.spec.nodeSelector } : {}),
      ...(base.spec.terminationGracePeriodSeconds !== undefined || patch.spec?.terminationGracePeriodSeconds !== undefined ? { terminationGracePeriodSeconds: patch.spec?.terminationGracePeriodSeconds ?? base.spec.terminationGracePeriodSeconds } : {}),
      ...(base.spec.dnsConfig || patch.spec?.dnsConfig ? { dnsConfig: patch.spec?.dnsConfig ?? base.spec.dnsConfig } : {}),
      ...(base.spec.hostAliases || patch.spec?.hostAliases ? { hostAliases: patch.spec?.hostAliases ?? base.spec.hostAliases } : {}),
    },
    ...(base.providerOverrides || patch.providerOverrides ? { providerOverrides: { ...base.providerOverrides, ...patch.providerOverrides } } : {}),
  };
}
