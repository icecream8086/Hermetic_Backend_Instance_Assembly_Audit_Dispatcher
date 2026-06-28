/**
 * PodService — full lifecycle management for Pods.
 * Mirrors SandboxService but operates on PodSpec/PodPhase/PodEntity.
 */

import type { IAtomicStore } from '../store/interfaces.ts';
import type { IContainerProvider } from '../provider/interfaces.ts';
import type { CreateContainerGroupInput, ContainerGroupRuntime } from '../provider/types.ts';
import { ContainerGroupState } from '../provider/container-lifecycle.ts';
import { createRegionId } from '../region/types.ts';
import { generateVersionId } from '../brand.ts';
import { AppError } from '../types.ts';
import { PodStore } from './store.ts';
import type { PodPhase, PodEntity, PodNetwork } from './types.ts';
import { createPodId } from './types.ts';

// ═══════════════════════════════════════════════════════════════
// Adapters (to be replaced by PodCodec injection)
// ═══════════════════════════════════════════════════════════════

function podSpecToGroupInput(spec: import('./types.ts').PodSpec): CreateContainerGroupInput {
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
    state: (
      c.status.toLowerCase() === 'running' ? { state: 'Running' as const, startedAt: c.startedAt ?? '' } :
      c.status.toLowerCase() === 'exited' || c.status.toLowerCase() === 'terminated' ? { state: 'Terminated' as const, exitCode: c.exitCode ?? 0, startedAt: c.startedAt, finishedAt: c.finishedAt } :
      { state: 'Waiting' as const }
    ),
    env: c.env,
    ports: c.network?.ports.map(p => ({ containerPort: p.containerPort, hostPort: p.hostPort ?? undefined, protocol: p.protocol })),
    resources: c.resources ? { cpu: c.resources.cpu, memory: c.resources.memory, gpu: c.resources.gpu } : undefined,
    labels: c.labels,
    annotations: c.annotations,
    mounts: c.mounts,
  }));
}

// ═══════════════════════════════════════════════════════════════
// PodService
// ═══════════════════════════════════════════════════════════════

export class PodService {
  private readonly store: PodStore;

  constructor(
    atomic: IAtomicStore,
    private readonly provider: IContainerProvider,
  ) {
    this.store = new PodStore(atomic);
  }

  async provision(spec: import('./types.ts').PodSpec): Promise<PodEntity> {
    const podId = createPodId(crypto.randomUUID());
    const groupInput = podSpecToGroupInput(spec);
    const { providerId } = await this.provider.create(groupInput);
    const initialPhase: PodPhase = this.provider.lifecycle.asyncInit ? 'Pending' : 'Running';

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
    await this.store.addToIndex(podId as string);
    return entity;
  }

  async getById(podId: import('./types.ts').PodId): Promise<PodEntity | null> {
    return this.store.getById(podId);
  }

  async list(phase?: PodPhase, limit = 50, cursor?: string): Promise<{ items: PodEntity[]; nextCursor?: string }> {
    return this.store.list(phase, limit, cursor);
  }

  async stop(podId: import('./types.ts').PodId): Promise<PodEntity> {
    const pod = await this.store.getById(podId);
    if (!pod) throw new AppError(404, 'POD_NOT_FOUND', `Pod ${podId} not found`);
    if (pod.providerId) {
      try { await this.provider.stop?.(pod.providerId); } catch { /* best-effort */ }
    }
    const targetPhase: PodPhase = this.provider.lifecycle.stopIsDelete ? 'Running' : 'Succeeded';
    return this.store.transition(podId, targetPhase);
  }

  async start(podId: import('./types.ts').PodId): Promise<PodEntity> {
    const pod = await this.store.getById(podId);
    if (!pod) throw new AppError(404, 'POD_NOT_FOUND', `Pod ${podId} not found`);
    if (pod.providerId) {
      try { await this.provider.start?.(pod.providerId); } catch { /* best-effort */ }
    }
    return this.store.transition(podId, 'Running');
  }

  async terminate(podId: import('./types.ts').PodId): Promise<void> {
    const pod = await this.store.getById(podId);
    if (!pod) throw new AppError(404, 'POD_NOT_FOUND', `Pod ${podId} not found`);
    if (pod.providerId) {
      try { await this.provider.delete({ region: createRegionId('cn-hangzhou'), providerId: pod.providerId }); } catch { /* GC will retry */ }
    }
    await this.store.transition(podId, 'Failed');
    await this.store.removeFromIndex(podId as string);
  }

  async syncRuntime(podId: import('./types.ts').PodId): Promise<PodEntity> {
    const pod = await this.store.getById(podId);
    if (!pod || !pod.providerId) throw new AppError(404, 'POD_NOT_FOUND', `Pod ${podId} not found or has no providerId`);
    const result = await this.provider.describe({ region: createRegionId('cn-hangzhou'), sandboxId: pod.providerId });
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
}
