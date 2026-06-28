/**
 * AlibabaPodCodec — CEA bidirectional codec for Alibaba Cloud ECI.
 *
 * Implements PodCodec<Record<string, string>>.
 *   encode: PodSpec → buildPodCreateParams() → RPC params (no intermediate type)
 *   decode: raw ECI response → parseContainerGroup() → ContainerGroupRuntime → PodRuntime
 */

import { z } from 'zod';
import type { PodCodec } from '../../core/pod/codec.ts';
import type { PodSpec, PodRuntime, PodPhase, ContainerState } from '../../core/pod/types.ts';
import { createPodId } from '../../core/pod/types.ts';
import type { ContainerGroupRuntime, OciContainer } from '../../core/provider/types.ts';
import { ContainerGroupState } from '../../core/provider/container-lifecycle.ts';
import { buildPodCreateParams, parseContainerGroup } from './eci-codec.ts';

const eciResponseSchema = z.record(z.string(), z.unknown());

// ═══════════════════════════════════════════════════════════════
// ContainerGroupRuntime → PodRuntime
// ═══════════════════════════════════════════════════════════════

function containerStateFromOci(c: OciContainer): ContainerState {
  const s = c.status.toLowerCase();
  if (s === 'running') return { state: 'Running', startedAt: c.startedAt ?? '' };
  if (s === 'exited' || s === 'terminated') return { state: 'Terminated', exitCode: c.exitCode ?? 0, startedAt: c.startedAt, finishedAt: c.finishedAt };
  return { state: 'Waiting' };
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

function toPodRuntime(cg: ContainerGroupRuntime, podId: string): PodRuntime {
  const eip = cg.associatedResources[0];
  const publicIp = eip?.ip;

  const ready: 'True' | 'False' = cg.status === ContainerGroupState.Running ? 'True' : 'False';
  return {
    podId: createPodId(podId),
    providerId: cg.providerId,
    name: cg.name,
    phase: toPodPhase(cg.status),
    conditions: [
      { type: 'PodScheduled', status: 'True', lastTransitionTime: Date.now() },
      { type: 'ContainersReady', status: ready, lastTransitionTime: Date.now() },
    ],
    containers: cg.containers.map(c => ({
      name: c.name,
      image: c.image,
      state: containerStateFromOci(c),
      env: c.env,
      ports: c.network?.ports.map(p => ({ containerPort: p.containerPort, hostPort: p.hostPort ?? undefined, protocol: p.protocol })),
      resources: c.resources ? { cpu: c.resources.cpu, memory: c.resources.memory, gpu: c.resources.gpu } : undefined,
      labels: c.labels,
      annotations: c.annotations,
      mounts: c.mounts,
    })),
    volumes: cg.volumes.map(v => ({ name: v.name, type: v.type })),
    events: cg.events.map(e => ({ reason: e.reason, type: e.type, message: e.message, count: e.count })),
    network: {
      privateIp: cg.network.privateIp,
      publicIp,
      vpcId: cg.network.vpcId,
      subnetId: cg.network.subnetId,
      securityGroupId: cg.network.securityGroupId,
    },
    createdAt: cg.creationTime,
  };
}

// ═══════════════════════════════════════════════════════════════
// AlibabaPodCodec
// ═══════════════════════════════════════════════════════════════

export class AlibabaPodCodec implements PodCodec<Record<string, string>> {
  public readonly providerId = 'alibaba';

  public constructor(private readonly region: string) {}

  public encode(input: PodSpec): Record<string, string> {
    return buildPodCreateParams(input, this.region);
  }

  public decode(raw: unknown): PodRuntime {
    const validated = eciResponseSchema.parse(raw);
    const cg = parseContainerGroup(validated);
    return toPodRuntime(cg, cg.providerId);
  }

  public decodeStatus(raw: unknown): PodPhase {
    const validated = eciResponseSchema.parse(raw);
    const cg = parseContainerGroup(validated);
    return toPodPhase(cg.status);
  }
}
