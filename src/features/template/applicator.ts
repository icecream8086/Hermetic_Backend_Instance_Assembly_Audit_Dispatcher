import type { SandboxTemplate, TemplateContainer, TemplateStorage } from './types.ts';
import type { CreateSandboxInput, Volume, VolumeMount } from '../sandbox/types.ts';
import { VolumeType, VolumeStatus, createVolumeId } from '../sandbox/types.ts';
import type { SpotStrategy } from '../sandbox/types.ts';

/**
 * Apply a resolved template to produce a CreateSandboxInput.
 */
export function applyTemplate(tpl: SandboxTemplate, name?: string, region?: string): CreateSandboxInput {
  const spec = tpl.spec;
  const cpu = spec.containers.reduce((s, c) => s + (c.resources?.limits?.cpu ?? c.resources?.requests?.cpu ?? 1), 0);
  const memory = spec.containers.reduce((s, c) => s + (c.resources?.limits?.memory ?? c.resources?.requests?.memory ?? 512), 0);

  // Map template storage → sandbox volumes + volume mounts (mounted to first container)
  const { volumes, volumeMounts } = mapStorage(spec.storage);

  return {
    name: name ?? tpl.name,
    region: (region ?? spec.region) as any,
    resourceSpec: { cpu, memory },
    spotStrategy: (spec.spotStrategy ?? 'None') as SpotStrategy,
    restartPolicy: (spec.restartPolicy ?? 'Always') as any,
    containers: spec.containers.map((c: TemplateContainer, i: number) => ({
      name: c.name,
      image: c.image,
      ...(c.args ? { args: c.args } : {}),
      ...(c.env ? { env: c.env.map((e: any) => ({ name: e.name, value: e.value })) } : {}),
      ...(c.resources ? {
        resources: {
          ...(c.resources.requests ? { requests: { cpu: c.resources.requests.cpu ?? 0, memory: c.resources.requests.memory ?? 0 } } : {}),
          ...(c.resources.limits ? { limits: { cpu: c.resources.limits.cpu ?? 0, memory: c.resources.limits.memory ?? 0, gpu: c.resources.limits.gpu } } : {}),
        },
      } : {}),
      ...(c.ports ? { ports: c.ports } : {}),
      ...(i === 0 && volumeMounts.length > 0 ? { volumeMounts } : {}),
      ...(c.livenessProbe ? { livenessProbe: c.livenessProbe } : {
        livenessProbe: {
          tcpSocket: { port: c.ports?.[0]?.containerPort ?? 80 },
          periodSeconds: 30,
          failureThreshold: 3,
        },
      }),
      ...(c.readinessProbe ? { readinessProbe: c.readinessProbe } : {}),
    })),
    ...(volumes.length > 0 ? { volumes } : {}),
    ...(spec.account ? { account: spec.account } : {}),
    ...(spec.extensions?.healthMaxRetries !== undefined ? { healthMaxRetries: spec.extensions.healthMaxRetries as number } : {}),
    network: {
      allocatePublicIp: spec.network?.allocatePublicIp ?? false,
      ...(spec.network?.publicIpBandwidth !== undefined ? { publicIpBandwidth: spec.network.publicIpBandwidth } : {}),
      ...(spec.network?.securityGroupId ? { securityGroupId: spec.network.securityGroupId } : {}),
      ...(spec.network?.subnetIds ? { subnetIds: spec.network.subnetIds } : {}),
    },
    description: tpl.description,
    ...(spec.providerOverrides ? { providerOverrides: spec.providerOverrides } : {}),
  } as CreateSandboxInput;
}

/**
 * Map TemplateSpec.storage[] → { Volume[], VolumeMount[] }.
 */
export function mapStorage(
  storage: readonly TemplateStorage[] | undefined,
): { volumes: Volume[]; volumeMounts: VolumeMount[] } {
  if (!storage || storage.length === 0) return { volumes: [], volumeMounts: [] };

  const now = Date.now();
  const volumes: Volume[] = [];
  const volumeMounts: VolumeMount[] = [];

  for (const s of storage) {
    const vid = createVolumeId(s.name);

    switch (s.type) {
      case 'nfs': {
        if (!s.nfs) break;
        volumes.push({
          id: vid, name: s.name, tags: [], createdAt: now, updatedAt: now,
          status: VolumeStatus.Detached, type: VolumeType.NFS,
          nfs: { server: s.nfs.server, path: s.nfs.path, readOnly: s.nfs.readOnly ?? false },
        });
        volumeMounts.push({ volumeId: vid, mountPath: s.mountPath, readOnly: s.nfs.readOnly ?? false });
        break;
      }
      case 'hostPath': {
        volumes.push({
          id: vid, name: s.name, tags: [], createdAt: now, updatedAt: now,
          status: VolumeStatus.Detached, type: VolumeType.HostPath,
        });
        volumeMounts.push({ volumeId: vid, mountPath: s.mountPath, readOnly: false });
        break;
      }
      case 'emptyDir': {
        volumes.push({
          id: vid, name: s.name, tags: [], createdAt: now, updatedAt: now,
          status: VolumeStatus.Detached, type: VolumeType.EmptyDir,
        });
        volumeMounts.push({ volumeId: vid, mountPath: s.mountPath, readOnly: false });
        break;
      }
      case 'oss': {
        if (!s.oss) break;
        volumes.push({
          id: vid, name: s.name, tags: [], createdAt: now, updatedAt: now,
          status: VolumeStatus.Detached, type: VolumeType.HostPath,
        });
        volumeMounts.push({ volumeId: vid, mountPath: s.mountPath, readOnly: s.oss.readOnly ?? false });
        break;
      }
    }
  }

  return { volumes, volumeMounts };
}
