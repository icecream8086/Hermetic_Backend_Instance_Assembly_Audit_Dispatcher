import type { SandboxTemplate, ContainerSpec, ContainerDef, HealthCheckDef, TemplateStorage, NetworkSpec } from './types.ts';
import type { CreateSandboxInput, Volume, VolumeMount } from '../sandbox/types.ts';
import { VolumeType, VolumeStatus, createVolumeId } from '../sandbox/types.ts';
import type { SpotStrategy } from '../sandbox/types.ts';

/**
 * Map a resolved template to CreateSandboxInput.
 *
 * Core mapping:  template.container.containers → input.containers
 * Probes mapped from template.healthChecks (matched by target="container:<name>")
 * Network from template.network
 * Provider overrides from template.providerOverrides
 */
export function applyTemplate(tpl: SandboxTemplate, name?: string, region?: string): CreateSandboxInput {
  const container: ContainerSpec = tpl.container ?? { region: 'local' as any, containers: [] };
  const containers = container.containers ?? [];
  const cpu = containers.reduce((s, c) => s + (c.resources?.limits?.cpu ?? c.resources?.requests?.cpu ?? 1), 0);
  const memory = containers.reduce((s, c) => s + (c.resources?.limits?.memory ?? c.resources?.requests?.memory ?? 512), 0);

  const ext = tpl.extensions;
  const { volumes, volumeMounts } = mapStorage(ext?.storage);

  // Build a per-container probe map from healthChecks[]
  const probeMap = buildProbeMap(tpl.healthChecks);

  // Assign volume mounts to first container only (backward compat)
  const mainVolMounts = volumeMounts.length > 0 ? volumeMounts : undefined;

  return {
    name: name ?? tpl.name,
    region: (region ?? container.region) as any,
    resourceSpec: { cpu, memory },
    spotStrategy: (ext?.spotStrategy ?? 'None') as SpotStrategy,
    restartPolicy: (container.restartPolicy ?? 'Always') as any,
    containers: containers.map((c: ContainerDef, i: number) => ({
      name: c.name,
      image: c.image,
      ...(c.command ? { command: [...c.command] } : {}),
      ...(c.args ? { args: [...c.args] } : {}),
      ...(c.env ? { env: c.env.map(e => ({
        name: e.name,
        ...(e.value !== undefined ? { value: e.value } : {}),
        ...(e.valueFrom !== undefined ? { valueFrom: e.valueFrom } : {}),
      })) } : {}),
      ...(c.resources ? {
        resources: {
          ...(c.resources.requests ? { requests: { cpu: c.resources.requests.cpu ?? 0, memory: c.resources.requests.memory ?? 0 } } : {}),
          ...(c.resources.limits ? { limits: { cpu: c.resources.limits.cpu ?? 0, memory: c.resources.limits.memory ?? 0, gpu: c.resources.limits.gpu } } : {}),
        },
      } : {}),
      ...(c.ports ? { ports: c.ports.map(p => ({
        containerPort: p.containerPort,
        ...(p.protocol ? { protocol: p.protocol } : {}),
      })) } : {}),
      ...(i === 0 && mainVolMounts ? { volumeMounts: mainVolMounts } : {}),
      // Probes from healthChecks
      ...(probeMap.get(`container:${c.name}`) || {}),
    })),
    ...(container.initContainers ? {
      initContainers: container.initContainers.map((c: ContainerDef) => ({
        name: c.name,
        image: c.image,
        ...(c.command ? { command: [...c.command] } : {}),
        ...(c.args ? { args: [...c.args] } : {}),
        ...(c.env ? { env: c.env.map(e => ({
          name: e.name,
          ...(e.value !== undefined ? { value: e.value } : {}),
          ...(e.valueFrom !== undefined ? { valueFrom: e.valueFrom } : {}),
        })) } : {}),
        ...(c.resources ? {
          resources: {
            ...(c.resources.requests ? { requests: { cpu: c.resources.requests.cpu ?? 0, memory: c.resources.requests.memory ?? 0 } } : {}),
            ...(c.resources.limits ? { limits: { cpu: c.resources.limits.cpu ?? 0, memory: c.resources.limits.memory ?? 0, gpu: c.resources.limits.gpu } } : {}),
          },
        } : {}),
        ...(probeMap.get(`init:${c.name}`) || {}),
      })),
    } : {}),
    ...(volumes.length > 0 ? { volumes } : {}),
    ...(container.account ? { account: container.account } : {}),
    ...(container.instanceId ? { instanceId: container.instanceId } : {}),
    ...(ext?.healthMaxRetries !== undefined ? { healthMaxRetries: ext.healthMaxRetries as number } : {}),
    network: mapNetwork(tpl.network),
    description: tpl.description,
    ...(ext?.providerOverrides ? { providerOverrides: ext.providerOverrides } : {}),
  } as unknown as CreateSandboxInput;
}

// ─── Health check → probe map ───

/**
 * Map healthChecks[] to per-container probe objects.
 * Returns: Map<"container:name", {livenessProbe?, readinessProbe?, startupProbe?}>
 */
function buildProbeMap(healthChecks: readonly HealthCheckDef[] | undefined): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  if (!healthChecks) return map;

  for (const hc of healthChecks) {
    let entry = map.get(hc.target);
    if (!entry) {
      entry = {};
      map.set(hc.target, entry);
    }
    const probeKey = `${hc.type}Probe`;
    (entry as any)[probeKey] = {
      ...hc.probe,
      ...(hc.initialDelaySeconds !== undefined ? { initialDelaySeconds: hc.initialDelaySeconds } : {}),
      ...(hc.periodSeconds !== undefined ? { periodSeconds: hc.periodSeconds } : {}),
      ...(hc.timeoutSeconds !== undefined ? { timeoutSeconds: hc.timeoutSeconds } : {}),
      ...(hc.successThreshold !== undefined ? { successThreshold: hc.successThreshold } : {}),
      ...(hc.failureThreshold !== undefined ? { failureThreshold: hc.failureThreshold } : {}),
    };
  }
  return map;
}

// ─── Network mapping ───

function mapNetwork(network: NetworkSpec | undefined): { allocatePublicIp: boolean; publicIpBandwidth?: number; securityGroupId?: string; subnetIds?: string[]; instanceId?: string } {
  if (!network) return { allocatePublicIp: false };

  return {
    allocatePublicIp: network.publicIp?.allocate ?? false,
    ...(network.publicIp?.bandwidth !== undefined ? { publicIpBandwidth: network.publicIp.bandwidth } : {}),
    ...(network.vpc?.securityGroupId ? { securityGroupId: network.vpc.securityGroupId } : {}),
    ...(network.vpc?.subnetIds ? { subnetIds: [...network.vpc.subnetIds] } : {}),
    ...(network.vpc?.instanceId ? { instanceId: network.vpc.instanceId } : {}),
  };
}

// ─── Storage → Volume + VolumeMount ───

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
          status: VolumeStatus.Detached, type: VolumeType.NFS,
        });
        volumeMounts.push({ volumeId: vid, mountPath: s.mountPath, readOnly: s.oss.readOnly ?? false });
        break;
      }
    }
  }

  return { volumes, volumeMounts };
}
