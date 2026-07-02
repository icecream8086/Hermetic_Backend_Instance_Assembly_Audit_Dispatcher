/** Pure mapping functions from provider runtime data to sandbox entity fields.
 *  Shared by SandboxService (syncRuntime) and health-check (auto-promotion).
 *  All functions are pure — no IO, no side effects. */

import type { ContainerGroupRuntime, OciContainerStatus } from '../../core/provider/types.ts';
import type { NetworkInfo, ContainerRuntime, ContainerEvent } from './types.ts';
import { ContainerStatus } from './types.ts';
import { createVolumeId } from './types.ts';

export function eipFromResources(
  resources: ContainerGroupRuntime['associatedResources'],
): string | undefined {
  const eip = resources[0];
  return eip?.ip;
}

export function runtimeToNetwork(
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

export function ociStatusToContainerState(s: OciContainerStatus): ContainerStatus {
  switch (s) {
    case 'running': return ContainerStatus.Running;
    case 'paused': return ContainerStatus.Running;
    case 'stopped':
    case 'error':
    case 'deleted': return ContainerStatus.Terminated;
    case 'creating':
    case 'created':
    default: return ContainerStatus.Waiting;
  }
}

export function runtimeToContainers(r: ContainerGroupRuntime): ContainerRuntime[] {
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
      ...(c.finishedAt ? { finishedTime: c.finishedAt } : {}),
      ...(c.exitCode !== undefined ? { exitCode: c.exitCode } : {}),
    },
    volumeMounts: c.mounts.map(m => ({
      volumeId: createVolumeId('unknown'), // provider mounts don't reference our internal volume IDs
      mountPath: m.destination,
      readOnly: m.options?.includes('ro') ?? false,
    })),
    health: {
      status: c.health.status,
      ...(c.health.lastCheckedAt !== undefined ? { lastCheckedAt: c.health.lastCheckedAt } : {}),
      ...(c.health.message !== undefined ? { message: c.health.message } : {}),
    },
  }));
}

export function runtimeToEvents(r: ContainerGroupRuntime): ContainerEvent[] {
  return r.events.map(e => ({
    _brand: 'ValueObject',
    reason: e.reason,
    type: e.type,
    message: e.message,
    count: e.count,
    ...(e.lastTimestamp !== undefined ? { lastTimestamp: e.lastTimestamp } : {}),
  }));
}
