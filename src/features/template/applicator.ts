import type { Template, ContainerSpec, ContainerDef, HealthCheckDef, TemplateStorage } from './types.ts';
import type { Volume, VolumeMount } from '../sandbox/types.ts';
import type { PodSpec } from '../../core/pod/types.ts';
import type { EnvVar, ProbeSpec } from '../../core/provider/types.ts';
import { VolumeType, VolumeStatus, createVolumeId } from '../sandbox/types.ts';
import { createRegionId } from '../../core/region/types.ts';
import { z } from 'zod';

import { EmptyDirMedium } from '../sandbox/types.ts';
import type { NFSVolumeConfig, DiskVolumeConfig, SecretVolumeConfig } from '../sandbox/types.ts';
import type { SecurityResourceService } from '../../core/security/service.ts';
import { SecurityResourceStatus } from '../../core/security/types.ts';

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
/** Resolve a ContainerSecret by name. Returns { value, platformRefs } or null. */
export interface ContainerSecretResolveResult {
  readonly value?: string | undefined;
  readonly platformRefs?: import('../container-secret/types.ts').PlatformSecretRefs | undefined;
}

interface AlibabaOverrides {
  region: string;
  instanceId?: string;
  zoneId?: string;
  account?: string;
  healthMaxRetries?: number;
  apiVersion?: string;
  description?: string;
  securityGroupId?: string;
  subnetIds?: string[];
  autoCreateEip?: boolean;
}

export async function applyTemplate(
  tpl: Template,
  name?: string,
  region?: string,
  resolveVolume?: (id: string) => Promise<Record<string, unknown> | null>,
  securityStore?: SecurityResourceService,
  resolveContainerSecret?: (name: string) => Promise<ContainerSecretResolveResult | null>,
): Promise<{ podSpec: PodSpec; securityRefNames: string[] }> {
  const container: ContainerSpec = tpl.container ?? { region: createRegionId('local'), containers: [] };
  const containers = container.containers;

  const ext = tpl.extensions;
  const { volumes, volumeMounts, configMapEnv, securityRefNames, podSecretRefs, resolvedSecrets } = await mapStorage(ext?.storage, resolveVolume, securityStore, resolveContainerSecret);

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
  const restartPolicy: 'Always' | 'OnFailure' | 'Never' =
    (rp === 'Always' || rp === 'OnFailure' || rp === 'Never') ? rp : 'Always';

  const labels = tpl.metadata?.labels;
  const net = tpl.network;
  const tplOverrides: Record<string, unknown> = ext?.providerOverrides?.alibaba ?? {};

  const alibabaOverrides: AlibabaOverrides = {
    // ① 继承模板原有的 ECI 配置 (spotStrategy, instanceType, autoCreateEip...)
    ...tplOverrides,
    // ② 从模板 network 继承 VPC 网络配置
    ...(net?.vpc?.securityGroupId ? { securityGroupId: net.vpc.securityGroupId } : {}),
    ...(net?.vpc?.subnetIds?.length ? { subnetIds: [...net.vpc.subnetIds] } : {}),
    // ③ 从模板顶层提取的核心字段 (覆盖同名配置)
    region: region ?? String(container.region),
    ...(container.instanceId ? { instanceId: container.instanceId } : {}),
    ...(container.account ? { account: container.account } : {}),
    ...(ext?.healthMaxRetries !== undefined ? { healthMaxRetries: ext.healthMaxRetries } : {}),
  };

  const podSpec: PodSpec = {
    metadata: {
      name: name ?? `${tpl.name}-${crypto.randomUUID().slice(0, 6)}`,
      ...(labels && Object.keys(labels).length > 0 ? { labels } : {}),
    },
    spec: {
      containers: containers.map((c: ContainerDef, i: number) => ({
        name: c.name,
        image: c.image,
        ...(c.command ? { command: [...c.command] } : {}),
        ...(c.args ? { args: [...c.args] } : {}),
        ...((e => e ? { env: e } : {})(mergeEnv(c.env))),
        ...(c.resources ? {
          resources: {
            limits: {
              cpu: c.resources.limits?.cpu ?? 0,
              memory: c.resources.limits?.memory ?? 0,
              ...(c.resources.limits?.gpu !== undefined ? { gpu: c.resources.limits.gpu } : {}),
              ...(c.resources.limits?.gpuType !== undefined ? { gpuType: c.resources.limits.gpuType } : {}),
            },
          },
        } : {}),
        ...(c.ports ? { ports: c.ports.map(p => ({
          containerPort: p.containerPort,
          ...(p.protocol ? { protocol: p.protocol } : {}),
        })) } : {}),
        ...(i === 0 && mainVolMounts ? { volumeMounts: mainVolMounts } : {}),
        ...(probeMap.get(`container:${c.name}`) ?? {}),
      })),
      restartPolicy,
      ...(container.initContainers?.length ? {
        initContainers: container.initContainers.map((c: ContainerDef) => ({
          name: c.name,
          image: c.image,
          ...(c.command ? { command: [...c.command] } : {}),
          ...(c.args ? { args: [...c.args] } : {}),
          ...((e => e ? { env: e } : {})(mergeEnv(c.env))),
          ...(c.resources ? {
            resources: {
              limits: {
                cpu: c.resources.limits?.cpu ?? 0,
                memory: c.resources.limits?.memory ?? 0,
                ...(c.resources.limits?.gpu !== undefined ? { gpu: c.resources.limits.gpu } : {}),
                ...(c.resources.limits?.gpuType !== undefined ? { gpuType: c.resources.limits.gpuType } : {}),
              },
            },
          } : {}),
          ...(probeMap.get(`init:${c.name}`) ?? {}),
        })),
      } : {}),
      ...(volumes.length > 0 ? { volumes: volumes.map(v => ({ id: v.id, type: v.type, options: 'options' in v ? v.options as Record<string, unknown> : undefined })) } : {}),
      ...(podSecretRefs.length > 0 ? { secretRefs: podSecretRefs, resolvedSecrets } : {}),
    },
    providerOverrides: {
      alibaba: alibabaOverrides,
    },
  };

  return { podSpec, securityRefNames };
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
  resolveContainerSecret?: (name: string) => Promise<ContainerSecretResolveResult | null>,
): Promise<{
  volumes: Volume[];
  volumeMounts: VolumeMount[];
  configMapEnv: { name: string; value: string }[];
  securityRefNames: string[];
  podSecretRefs: import('../../core/pod/types.ts').PlatformSecretRef[];
  resolvedSecrets: import('../../core/pod/types.ts').ResolvedSecretsMap;
}> {
  if (!storage || storage.length === 0) return { volumes: [], volumeMounts: [], configMapEnv: [], securityRefNames: [], podSecretRefs: [], resolvedSecrets: {} };

  const now = Date.now();
  const volumes: Volume[] = [];
  const volumeMounts: VolumeMount[] = [];
  const securityRefNames: string[] = [];
  const configMapEnv: { name: string; value: string }[] = [];
  const podSecretRefs: import('../../core/pod/types.ts').PlatformSecretRef[] = [];
  const resolvedSecrets: import('../../core/pod/types.ts').ResolvedSecretsMap = {};

  for (const s of storage) {
    const vid = createVolumeId(s.name);

    // If securityRefs is set, collect names (mutually exclusive with other storage types)
    if ((s.securityRefs?.length || s.securityRef) && securityStore) {
      const names = s.securityRefs ?? (s.securityRef ? [s.securityRef] : []);
      for (const name of names) {
        const sec = await securityStore.getByName(name);
        if (!sec) {
          throw new Error(`SecurityResource "${name}" not found`);
        }
        // V3: only verify policy exists and is Active — JWT issued later at sandbox provision
        if (sec.status !== SecurityResourceStatus.Active) {
          throw new Error(`SecurityResource "${name}" is ${sec.status}`);
        }
        securityRefNames.push(name);
      }
      continue;
    }

    // If containerSecretRefs is set, resolve ContainerSecrets for platform-native secret injection
    if (s.containerSecretRefs?.length && resolveContainerSecret) {
      for (const ref of s.containerSecretRefs) {
        const cs = await resolveContainerSecret(ref.name);
        if (!cs) {
          throw new Error(`ContainerSecret "${ref.name}" not found`);
        }
        podSecretRefs.push({
          secretName: ref.name,
          mountPath: s.mountPath,
          keys: ref.keys,
          mode: 0o400,
        });
        if (cs.value !== undefined || cs.platformRefs !== undefined) {
          resolvedSecrets[ref.name] = {
            ...(cs.value !== undefined ? { value: cs.value } : {}),
            ...(cs.platformRefs !== undefined ? { platformRefs: cs.platformRefs } : {}),
          };
        }
      }
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

  return { volumes, volumeMounts, configMapEnv, securityRefNames, podSecretRefs, resolvedSecrets };
}
