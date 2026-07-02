import type { SandboxTemplate, ContainerSpec, ContainerDef, HealthCheckDef, TemplateStorage, NetworkSpec } from './types.ts';
import type { CreateSandboxInput, Volume, VolumeMount, SandboxNetworkConfig, SecurityResourceRef } from '../sandbox/types.ts';
import type { EnvVar, ProbeSpec } from '../../core/provider/types.ts';
import { VolumeType, VolumeStatus, createVolumeId } from '../sandbox/types.ts';
import { createRegionId } from '../../core/region/types.ts';
import { z } from 'zod';

import { EmptyDirMedium } from '../sandbox/types.ts';
import type { NFSVolumeConfig, DiskVolumeConfig, SecretVolumeConfig } from '../sandbox/types.ts';
import type { SecurityResourceService } from '../../core/security/service.ts';

const ValueFromSchema = z.custom<EnvVar['valueFrom']>(
  (v): v is EnvVar['valueFrom'] => v === undefined || (v !== null && typeof v === 'object'),
);

const VolTypeSchema = z.nativeEnum(VolumeType);
const NfsConfigSchema = z.custom<NFSVolumeConfig>(v => v !== null && typeof v === 'object' && !Array.isArray(v));
const DiskConfigSchema = z.custom<DiskVolumeConfig>(v => v !== null && typeof v === 'object' && !Array.isArray(v));
const SecretConfigSchema = z.custom<SecretVolumeConfig>(v => v !== null && typeof v === 'object' && !Array.isArray(v));
const StrSchema = z.string();

/**
 * Map a resolved template to CreateSandboxInput.
 *
 * Core mapping:  template.container.containers → input.containers
 * Probes mapped from template.healthChecks (matched by target="container:<name>")
 * Network from template.network
 * Provider overrides from template.providerOverrides
 */
/**
 * @param resolveVolume Optional callback to resolve a Volume entity by ID.
 *   When a TemplateStorage has `volumeId`, this callback fetches the Volume
 *   and merges its nfs/disk/configMap/secret config into the storage entry.
 * @param securityStore Optional SecurityResourceService for resolving securityRef.
 *   When a TemplateStorage has `securityRef`, this service fetches the
 *   SecurityResource and validates its presigned URL validity.
 */
export async function applyTemplate(
  tpl: SandboxTemplate,
  name?: string,
  region?: string,
  resolveVolume?: (id: string) => Promise<Record<string, unknown> | null>,
  securityStore?: SecurityResourceService,
): Promise<CreateSandboxInput> {
  const container: ContainerSpec = tpl.container ?? { region: createRegionId('local'), containers: [] };
  const containers = container.containers;
  const cpu = containers.reduce((s, c) => s + (c.resources?.limits?.cpu ?? c.resources?.requests?.cpu ?? 1), 0);
  const memory = containers.reduce((s, c) => s + (c.resources?.limits?.memory ?? c.resources?.requests?.memory ?? 2048), 0);
  const gpu = Math.max(...containers.map(c => c.resources?.limits?.gpu ?? 0));
  const gpuType = containers.find(c => (c.resources?.limits?.gpu ?? 0) > 0)?.resources?.limits?.gpuType;

  const ext = tpl.extensions;
  const { volumes, volumeMounts, configMapEnv, securityRefs } = await mapStorage(ext?.storage, resolveVolume, securityStore);

  // Assign volume mounts to first container only (backward compat)
  const mainVolMounts = volumeMounts.length > 0 ? volumeMounts : undefined;

  // Build a per-container probe map from healthChecks[]
  const probeMap = buildProbeMap(tpl.healthChecks);

  // Merge template-level env + configMap env for main containers
  function mergeEnv(existing: readonly { name: string; value?: string; valueFrom?: unknown }[] | undefined): EnvVar[] | undefined {
    const merged: EnvVar[] = [];
    if (existing) {
      for (const e of existing) {
        if (e.valueFrom !== undefined) {
          const parsedValueFrom = ValueFromSchema.parse(e.valueFrom);
          merged.push({
            name: e.name,
            valueFrom: parsedValueFrom,
          });
        } else if (e.value !== undefined) {
          merged.push({
            name: e.name,
            value: e.value,
          });
        } else {
          merged.push({ name: e.name });
        }
      }
    }
    merged.push(...configMapEnv);
    return merged.length > 0 ? merged : undefined;
  }

  // Validate restartPolicy at the boundary — narrows from string to literal union
  const rp = container.restartPolicy ?? 'Always';
  const restartPolicy: CreateSandboxInput['restartPolicy'] =
    (rp === 'Always' || rp === 'OnFailure' || rp === 'Never') ? rp : 'Always';

  return {
    name: name ?? `${tpl.name}-${crypto.randomUUID().slice(0, 6)}`,
    templateRef: tpl.id,
    region: createRegionId(region ?? String(container.region)),
    resourceSpec: { cpu, memory, ...(gpu > 0 ? { gpu, ...(gpuType ? { gpuType } : {}) } : {}) },
    restartPolicy,
    containers: containers.map((c: ContainerDef, i: number) => ({
      name: c.name,
      image: c.image,
      ...(c.command ? { command: [...c.command] } : {}),
      ...(c.args ? { args: [...c.args] } : {}),
      ...((e => e ? { env: e } : {})(mergeEnv(c.env))),
      ...(c.resources ? {
        resources: {
          ...(c.resources.requests ? { requests: { cpu: c.resources.requests.cpu ?? 0, memory: c.resources.requests.memory ?? 0 } } : {}),
          ...(c.resources.limits ? { limits: { cpu: c.resources.limits.cpu ?? 0, memory: c.resources.limits.memory ?? 0, ...(c.resources.limits.gpu !== undefined ? { gpu: c.resources.limits.gpu } : {}), ...(c.resources.limits.gpuType !== undefined ? { gpuType: c.resources.limits.gpuType } : {}) } } : {}),
        },
      } : {}),
      ...(c.ports ? { ports: c.ports.map(p => ({
        containerPort: p.containerPort,
        ...(p.protocol ? { protocol: p.protocol } : {}),
      })) } : {}),
      ...(i === 0 && mainVolMounts ? { volumeMounts: mainVolMounts } : {}),
      ...(probeMap.get(`container:${c.name}`) ?? {}),
    })),
    ...(container.initContainers ? {
      initContainers: container.initContainers.map((c: ContainerDef) => ({
        name: c.name,
        image: c.image,
        ...(c.command ? { command: [...c.command] } : {}),
        ...(c.args ? { args: [...c.args] } : {}),
        ...((e => e ? { env: e.map(x => ({
          name: x.name,
          ...(x.value !== undefined ? { value: x.value } : {}),
          ...(x.valueFrom !== undefined ? { valueFrom: ValueFromSchema.parse(x.valueFrom) } : {}),
        })) } : {})(c.env)),
        ...(c.resources ? {
          resources: {
            ...(c.resources.requests ? { requests: { cpu: c.resources.requests.cpu ?? 0, memory: c.resources.requests.memory ?? 0 } } : {}),
            ...(c.resources.limits ? { limits: { cpu: c.resources.limits.cpu ?? 0, memory: c.resources.limits.memory ?? 0, ...(c.resources.limits.gpu !== undefined ? { gpu: c.resources.limits.gpu } : {}), ...(c.resources.limits.gpuType !== undefined ? { gpuType: c.resources.limits.gpuType } : {}) } } : {}),
          },
        } : {}),
        ...(probeMap.get(`init:${c.name}`) ?? {}),
      })),
    } : {}),
    ...(volumes.length > 0 ? { volumes } : {}),
    ...(securityRefs.length > 0 ? { securityResources: securityRefs } : {}),
    ...(container.account ? { account: container.account } : {}),
    ...(container.instanceId ? { instanceId: container.instanceId } : {}),
    ...(ext?.healthMaxRetries !== undefined ? { healthMaxRetries: ext.healthMaxRetries } : {}),
    network: mapNetwork(tpl.network),
    ...(tpl.description !== undefined ? { description: tpl.description } : {}),
    ...(ext?.providerOverrides ? { providerOverrides: ext.providerOverrides } : {}),
  };
}

// ─── Health check → probe map ───

/**
 * Map healthChecks[] to per-container probe objects.
 * Returns: Map<"container:name", {livenessProbe?, readinessProbe?, startupProbe?}>
 */
// Per-container probe bag — spread into ContainerConfig
interface ProbeBag {
  livenessProbe?: ProbeSpec | undefined;
  readinessProbe?: ProbeSpec | undefined;
  startupProbe?: ProbeSpec | undefined;
}

function buildProbeMap(healthChecks: readonly HealthCheckDef[] | undefined): Map<string, ProbeBag> {
  const map = new Map<string, ProbeBag>();
  if (!healthChecks) return map;

  for (const hc of healthChecks) {
    const entry = map.get(hc.target) ?? {};
    const probe: ProbeSpec = {
      ...hc.probe,
      ...(hc.initialDelaySeconds !== undefined ? { initialDelaySeconds: hc.initialDelaySeconds } : {}),
      ...(hc.periodSeconds !== undefined ? { periodSeconds: hc.periodSeconds } : {}),
      ...(hc.timeoutSeconds !== undefined ? { timeoutSeconds: hc.timeoutSeconds } : {}),
      ...(hc.successThreshold !== undefined ? { successThreshold: hc.successThreshold } : {}),
      ...(hc.failureThreshold !== undefined ? { failureThreshold: hc.failureThreshold } : {}),
    };
    const probeKey: keyof ProbeBag = `${hc.type}Probe`;
    entry[probeKey] = probe;
    map.set(hc.target, entry);
  }
  return map;
}

// ─── Network mapping ───

function mapNetwork(network: NetworkSpec | undefined): SandboxNetworkConfig {
  if (!network) return { allocatePublicIp: false };
  // allocatePublicIp: NEVER from template network.publicIp — EIP costs money,
  // must come through extensions.providerOverrides.alibaba.autoCreateEip.
  // VPC fields (securityGroupId, subnetIds) are cloud-neutral and pass through.
  return {
    allocatePublicIp: false,
    ...(network.ipAddress ? { ipAddress: network.ipAddress } : {}),
    ...(network.vpc?.securityGroupId ? { securityGroupId: network.vpc.securityGroupId } : {}),
    ...(network.vpc?.subnetIds ? { subnetIds: [...network.vpc.subnetIds] } : {}),
  };
}

// ─── EmptyDir mapping ───

function mapEmptyDirMedium(raw: string): EmptyDirMedium {
  switch (raw) {
    case 'Memory': return EmptyDirMedium.Memory;
    default: return EmptyDirMedium.Default;
  }
}

// ─── Storage → Volume + VolumeMount ───

export async function mapStorage(
  storage: readonly TemplateStorage[] | undefined,
  resolveVolume?: (id: string) => Promise<Record<string, unknown> | null>,
  securityStore?: SecurityResourceService,
): Promise<{
  volumes: Volume[];
  volumeMounts: VolumeMount[];
  configMapEnv: { name: string; value: string }[];
  securityRefs: SecurityResourceRef[];
}> {
  if (!storage || storage.length === 0) return { volumes: [], volumeMounts: [], configMapEnv: [], securityRefs: [] };

  const now = Date.now();
  const volumes: Volume[] = [];
  const volumeMounts: VolumeMount[] = [];
  const securityRefs: SecurityResourceRef[] = [];
  const configMapEnv: { name: string; value: string }[] = [];

  for (const s of storage) {
    const vid = createVolumeId(s.name);

    // If securityRef is set, resolve SecurityResource (mutually exclusive with other storage types)
    if (s.securityRef && securityStore) {
      const sec = await securityStore.getByName(s.securityRef);
      if (!sec) {
        throw new Error(`SecurityResource "${s.securityRef}" not found`);
      }
      const check = securityStore.checkValidity(sec);
      if (!check.valid) {
        throw new Error(check.reason!);
      }
      securityRefs.push({
        resourceId: sec.id,
        resourceName: sec.name,
        value: sec.value,
      });
      continue;
    }

    // If volumeId is set, resolve from store and merge config
    if (s.volumeId && resolveVolume) {
      const vol = await resolveVolume(s.volumeId);
      if (vol) {
        volumes.push({
          id: vid, name: s.name, tags: [], createdAt: now, updatedAt: now,
          status: VolumeStatus.Detached, type: VolTypeSchema.parse(vol.type ?? s.type),
          instanceId: s.instanceId,
          ...(vol.nfs !== undefined && vol.nfs !== null ? { nfs: NfsConfigSchema.parse(vol.nfs) } : {}),
          ...(vol.disk !== undefined && vol.disk !== null ? { disk: DiskConfigSchema.parse(vol.disk) } : {}),
          ...(vol.secret !== undefined && vol.secret !== null ? { secret: SecretConfigSchema.parse(vol.secret) } : {}),
        });
        volumeMounts.push({ volumeId: vid, mountPath: s.mountPath, readOnly: false, ...(vol.credentialRef !== undefined ? { credentialRef: StrSchema.parse(vol.credentialRef) } : {}) });
        continue;
      }
    }

    // Inline storage — credentialRef not applicable here (managed at Volume level)
    switch (s.type) {
      // ConfigMap is env-only — handled inline, no Volume entity needed
      case 'configMap': {
        if (!s.configMap?.env.length) break;
        configMapEnv.push(...s.configMap.env.map(e => ({ name: e.key, value: e.value })));
        break;
      }
      case 'nfs': {
        if (!s.nfs) break;
        volumes.push({
          id: vid, name: s.name, tags: [], createdAt: now, updatedAt: now,
          status: VolumeStatus.Detached, type: VolumeType.NFS,
          instanceId: s.instanceId,
          nfs: { server: s.nfs.server, path: s.nfs.path, readOnly: s.nfs.readOnly ?? false },
        });
        volumeMounts.push({ volumeId: vid, mountPath: s.mountPath, readOnly: s.nfs.readOnly ?? false });
        break;
      }
      case 'emptyDir': {
        if (!s.emptyDir?.sizeLimit) break; // sizeLimit 必选，无值则跳过
        volumes.push({
          id: vid, name: s.name, tags: [], createdAt: now, updatedAt: now,
          status: VolumeStatus.Detached, type: VolumeType.EmptyDir,
          instanceId: s.instanceId,
          emptyDir: {
            sizeLimit: s.emptyDir.sizeLimit,
            ...(s.emptyDir.medium ? { medium: mapEmptyDirMedium(s.emptyDir.medium) } : {}),
          },
        });
        volumeMounts.push({ volumeId: vid, mountPath: s.mountPath, readOnly: false });
        break;
      }
      case 'oss': {
        // @deprecated — OSS type is superseded by SecurityResource/securityRef.
        // Skip silently for backward compatibility with old templates.
        break;
      }
      case 'disk': {
        if (!s.disk) break;
        volumes.push({
          id: vid, name: s.name, tags: [], createdAt: now, updatedAt: now,
          status: VolumeStatus.Detached, type: VolumeType.Disk,
          instanceId: s.instanceId,
          disk: {
            diskId: s.disk.diskId,
            fsType: s.disk.fsType ?? 'ext4',
            readOnly: s.disk.readOnly ?? false,
            ...(s.disk.sizeGiB !== undefined ? { sizeGiB: s.disk.sizeGiB } : {}),
            ...(s.disk.deleteWithInstance !== undefined ? { deleteWithInstance: s.disk.deleteWithInstance } : {}),
          },
        });
        volumeMounts.push({ volumeId: vid, mountPath: s.mountPath, readOnly: s.disk.readOnly ?? false });
        break;
      }
      case 'secret': {
        if (!s.secret) break;
        volumes.push({
          id: vid, name: s.name, tags: [], createdAt: now, updatedAt: now,
          status: VolumeStatus.Detached, type: VolumeType.Secret,
          instanceId: s.instanceId,
          secret: { name: s.secret.name, ...(s.secret.items ? { items: s.secret.items.map(i => ({ key: i.key, path: i.path, ...(i.mode !== undefined ? { mode: i.mode } : {}) })) } : {}) },
        });
        volumeMounts.push({ volumeId: vid, mountPath: s.mountPath, readOnly: true });
        break;
      }
      default: {
        void (s.type satisfies never);
        throw new Error(`Unknown storage type: ${String(s.type)}`);
      }
    }
  }

  return { volumes, volumeMounts, configMapEnv, securityRefs };
}
