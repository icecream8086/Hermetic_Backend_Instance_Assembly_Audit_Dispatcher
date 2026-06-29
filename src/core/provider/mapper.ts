// ─── Shared mapping helpers ───
// Low-level type mappers used by both toContainerGroupInput() (sandbox) and
// PodResolver.toGroupInput() (assembly). Keeps field-level mapping DRY.
//
// Design: these accept plain-old-data input (not domain entity types) so they
// can be reused across different source types without cross-feature imports.

import type {
  ContainerPortConfig,
  EnvVar,
  VolumeMountConfig,
  VolumeConfigInput,
  ContainerGroupNetworkInput,
} from './types.ts';

// ─── Port mapping ───

export interface MappablePort {
  readonly containerPort: number;
  readonly hostPort?: number | undefined;
  readonly protocol?: string | undefined;
}

export function mapPort(p: MappablePort): ContainerPortConfig {
  return {
    containerPort: p.containerPort,
    ...(p.hostPort !== undefined ? { hostPort: p.hostPort } : {}),
    protocol: p.protocol ?? 'tcp',
  };
}

export function mapPorts(ports: readonly MappablePort[] | undefined): readonly ContainerPortConfig[] | undefined {
  if (!ports?.length) return undefined;
  return ports.map(mapPort);
}

// ─── Env var mapping ───

export interface MappableEnv {
  readonly name: string;
  readonly value?: string | undefined;
  readonly valueFrom?: EnvVar['valueFrom'] | string | undefined;
}

export function mapEnv(e: MappableEnv): EnvVar {
  let valueFrom: EnvVar['valueFrom'] | undefined;
  if (e.valueFrom !== undefined) {
    if (typeof e.valueFrom === 'string') {
      valueFrom = { fieldRef: { fieldPath: e.valueFrom } };
    } else {
      valueFrom = e.valueFrom;
    }
  }
  return {
    name: e.name,
    ...(e.value !== undefined ? { value: e.value } : {}),
    ...(valueFrom !== undefined ? { valueFrom } : {}),
  };
}

export function mapEnvVars(env: readonly MappableEnv[] | undefined): readonly EnvVar[] | undefined {
  if (!env?.length) return undefined;
  return env.map(mapEnv);
}

// ─── Volume mount mapping ───

export interface MappableVolumeMount {
  readonly volumeId: string;
  readonly mountPath: string;
  readonly readOnly: boolean;
  readonly mountPropagation?: string | undefined;
  readonly credentialRef?: string | undefined;
}

export function mapVolumeMount(vm: MappableVolumeMount): VolumeMountConfig {
  return {
    volumeId: vm.volumeId,
    mountPath: vm.mountPath,
    readOnly: vm.readOnly,
    ...(vm.mountPropagation ? { mountPropagation: vm.mountPropagation } : {}),
    ...(vm.credentialRef ? { credentialRef: vm.credentialRef } : {}),
  };
}

export function mapVolumeMounts(mounts: readonly MappableVolumeMount[] | undefined): readonly VolumeMountConfig[] | undefined {
  if (!mounts?.length) return undefined;
  return mounts.map(mapVolumeMount);
}

// ─── Volume config mapping ───

export interface MappableVolume {
  readonly id: string;
  readonly type: string;
  readonly nfs?: { readonly server: string; readonly path: string; readonly readOnly: boolean } | undefined;
  readonly disk?: { readonly diskId: string; readonly fsType: string; readonly sizeGiB?: number; readonly diskCategory?: string | undefined; readonly readOnly: boolean; readonly deleteWithInstance?: boolean | undefined } | undefined;
  readonly secret?: { readonly name: string; readonly items?: readonly { key: string; path: string; mode?: number }[] } | undefined;
}

export function mapVolume(v: MappableVolume): VolumeConfigInput {
  let options: Record<string, unknown> | undefined;
  if (v.nfs) {
    options = { server: v.nfs.server, path: v.nfs.path, readOnly: v.nfs.readOnly };
  } else if (v.disk) {
    options = { diskId: v.disk.diskId, fsType: v.disk.fsType, readOnly: v.disk.readOnly };
    if (v.disk.sizeGiB !== undefined) options.sizeGiB = v.disk.sizeGiB;
    if (v.disk.diskCategory) options.diskCategory = v.disk.diskCategory;
    if (v.disk.deleteWithInstance !== undefined) options.deleteWithInstance = v.disk.deleteWithInstance;
  } else if (v.secret) {
    options = { name: v.secret.name };
    if (v.secret.items) options.items = [...v.secret.items];
  }
  return { id: v.id, type: v.type, ...(options ? { options } : {}) };
}

export function mapVolumes(vols: readonly MappableVolume[] | undefined): readonly VolumeConfigInput[] | undefined {
  if (!vols?.length) return undefined;
  return vols.map(mapVolume);
}

// ─── Tag mapping ───

export interface MappableTag {
  readonly key: string;
  readonly value: string;
}

export function mapTags(tags: readonly MappableTag[] | undefined): readonly { key: string; value: string }[] | undefined {
  if (!tags?.length) return undefined;
  return tags.map(t => ({ key: t.key, value: t.value }));
}

// ─── Network config mapping ───

export interface MappableNetwork {
  readonly subnetIds?: readonly string[] | undefined;
  readonly securityGroupId?: string | undefined;
  readonly allocatePublicIp: boolean;
  readonly publicIpBandwidth?: number | undefined;
  readonly bandwidth?: {
    readonly egress?: number | undefined;
    readonly ingress?: number | undefined;
    readonly burst?: number | undefined;
    readonly priority?: number | undefined;
  } | undefined;
}

export function mapNetwork(n: MappableNetwork): ContainerGroupNetworkInput {
  return {
    ...(n.subnetIds?.length ? { subnetIds: [...n.subnetIds] } : {}),
    ...(n.securityGroupId ? { securityGroupId: n.securityGroupId } : {}),
    allocatePublicIp: n.allocatePublicIp,
    ...(n.publicIpBandwidth !== undefined ? { publicIpBandwidth: n.publicIpBandwidth } : {}),
    ...(n.bandwidth ? { bandwidth: { ...(n.bandwidth.egress !== undefined ? { egress: n.bandwidth.egress } : {}), ...(n.bandwidth.ingress !== undefined ? { ingress: n.bandwidth.ingress } : {}), ...(n.bandwidth.burst !== undefined ? { burst: n.bandwidth.burst } : {}), ...(n.bandwidth.priority !== undefined ? { priority: n.bandwidth.priority } : {}) } } : {}),
  };
}
