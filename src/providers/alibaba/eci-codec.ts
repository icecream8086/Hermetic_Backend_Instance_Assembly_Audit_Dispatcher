/**
 * ECI bidirectional field codec.
 *
 * Single source of truth for every CreateContainerGroupInput ↔ Alibaba RPC param
 * and DescribeContainerGroups response ↔ ContainerGroupRuntime mapping.
 *
 * # Compile-time completeness
 *
 * `ScalarKeys<T>` derives a union of scalar field names from the TS interface.
 * Codec tables use `Record<ScalarKeys<Interface>, ...>` — add a field to the
 * interface and the Record immediately errors with a missing-property diagnostic.
 * You MUST supply both `encode` and `decode` for every key.
 *
 * Nested arrays (containers, volumes, env, ports, probes) use `NestedSpec<T>`
 * which mechanically generates indexed flat params.
 *
 * # Files governed by this table
 *
 *   eci-container.ts  create() / update() / parseContainerGroup()
 *   This file         buildCreateParams() / parseContainerGroup()
 */

import { z } from 'zod';
import type {
  CreateContainerGroupInput,
  ContainerCreateConfig,
  ContainerGroupRuntime,
  VolumeConfigInput,
  VolumeRuntimeInfo,
  ProbeSpec,
  ContainerPortConfig,
  EnvVar,
  ContainerGroupRuntimeEvent,
  AssociatedResource,
} from '../../core/provider/types.ts';
import type { PodSpec, ContainerSpec } from '../../core/pod/types.ts';
import { createRegionId, createZoneId } from '../../core/region/types.ts';
import { createContainerId } from '../../core/provider/types.ts';
import { applyExtensionOverrides } from '../../core/provider/extension-schema.ts';
import './eci-schema.ts'; // register Alibaba ECI extension fields

// ═══════════════════════════════════════════════════════════════
// Internal codec types
// ═══════════════════════════════════════════════════════════════

/** Extract keys of T whose values are primitive scalars (string | number | boolean). */
type ScalarKeys<T> = {
  [K in keyof T]-?: T[K] extends string | number | boolean | undefined | null ? K : never
}[keyof T] & string;

/** Single field bidirectional codec.
 *  TEncode: value passed to encode (after null-check — NonNullable).
 *  TDecode: value returned by decode (full field type — may include |undefined). */
interface EciFieldCodec<TEncode, TDecode = TEncode> {
  readonly param: string;
  readonly responsePath: string;
  encode(v: TEncode): string;
  decode(v: unknown): TDecode;
}

/** Derive precise codec table type from an interface.
 *  encode receives NonNullable<T[P]> (null-checked by caller).
 *  decode returns T[P] (full type — matches the interface field).
 *  Wrong type → TS compile error. */
type CodecTable<T, K extends keyof T = ScalarKeys<T>> = {
  [P in K]: EciFieldCodec<NonNullable<T[P]>, T[P]>;
};

// ── method-syntax interface eliminates `any` from NestedSpec
//     Methods are bivariant so narrower encode/decode impls are accepted.

interface NestedCodec {
  readonly param: string;
  readonly responsePath: string;
  encode(v: unknown): string;
  decode(v: unknown): unknown;
}

/** Describes how to map an array from CreateContainerGroupInput into indexed RPC params. */
interface NestedSpec<TItem, TScalars extends Record<string, NestedCodec> = Record<string, NestedCodec>> {
  /** Prefix generator, e.g. i => `Container.${String(i + 1)}`. 1-indexed. */
  readonly prefix: (idx: number) => string;
  /** Extract the collection from the input. */
  readonly collection: (input: CreateContainerGroupInput) => readonly TItem[] | undefined;
  /** Scalar fields on each item, keyed by their property name on TItem. */
  readonly scalars: TScalars;
  /** Per-item compound builders — called for each item, return extra params. */
  readonly compound?: (item: TItem, pfx: string) => Record<string, string>;
}

/** Alibaba ECI DescribeContainerGroups response shape (subset). */
interface EciDescribeResponse {
  ContainerGroupId?: string;
  ContainerGroupName?: string;
  Status?: string;
  RegionId?: string;
  ZoneId?: string;
  InstanceType?: string;
  SpotStrategy?: string;
  Cpu?: number;
  Memory?: number;
  Gpu?: string;
  Discount?: number;
  RestartPolicy?: string;
  EphemeralStorage?: number;
  IntranetIp?: string;
  PrivateIp?: string;
  VpcId?: string;
  VSwitchId?: string;
  SecurityGroupId?: string;
  EniInstanceId?: string;
  CreationTime?: string;
  ExpiredTime?: string;
  Containers?: EciContainerItem[];
  Volumes?: EciVolumeItem[];
  Events?: EciEventItem[];
  Tags?: EciTagItem[];
  AssociatedResources?: EciAssociatedResource[];
}

interface EciContainerItem {
  ContainerId?: string;
  Name?: string;
  Image?: string;
  Args?: string[];
  EnvironmentVars?: EciEnvItem[];
  WorkingDir?: string;
  Status?: string;
  Cpu?: number;
  Memory?: number;
  Gpu?: string;
  CreationTime?: string;
  StartedAt?: string;
  FinishedAt?: string;
  ExitCode?: number;
  LivenessProbe?: EciProbeItem;
  ReadinessProbe?: EciProbeItem;
  StartupProbe?: EciProbeItem;
  Ports?: EciPortItem[];
}

interface EciEnvItem { Key?: string; Value?: string; FieldRefFieldPath?: string; }
interface EciProbeItem {
  TcpSocket?: { Port?: number };
  HttpGet?: { Path?: string; Port?: number; Scheme?: string };
  Exec?: { Commands?: string[] };
  InitialDelaySeconds?: number;
  PeriodSeconds?: number;
  TimeoutSeconds?: number;
  FailureThreshold?: number;
  SuccessThreshold?: number;
}
interface EciPortItem { Port?: number; Protocol?: string; }
interface EciVolumeItem {
  Name?: string;
  Type?: string;
  NFSVolume?: { Server?: string; Path?: string; ReadOnly?: boolean };
  OSSVolume?: { Bucket?: string; Path?: string; ReadOnly?: boolean; Endpoint?: string };
  DiskVolume?: { DiskId?: string; FsType?: string; DiskSize?: number; DiskCategory?: string; ReadOnly?: boolean; DeleteWithInstance?: boolean };
  EmptyDirVolume?: { Medium?: string; SizeLimit?: string };
  ConfigMapVolume?: { Name?: string; Items?: { Key?: string; Path?: string; Mode?: number }[] };
  SecretVolume?: { SecretName?: string; Items?: { Key?: string; Path?: string; Mode?: number }[] };
}
interface EciEventItem { Reason?: string; Type?: string; Message?: string; Count?: number; LastTimestamp?: string; }
interface EciTagItem { Key?: string; Value?: string; }
interface EciAssociatedResource {
  ResourceType?: string;
  ResourceId?: string;
  Ip?: string;
  Bandwidth?: number;
  Isp?: string;
  Status?: string;
}

// ═══════════════════════════════════════════════════════════════
// Codec decode helpers — Zod-validated, fail-fast on bad API data
// ═══════════════════════════════════════════════════════════════

const decStrSch = z.string();
const decNumSch = z.number();
const decStrOptSch = z.string().optional();
const decNumOptSch = z.number().optional();

export function decStr(v: unknown): string { return decStrSch.parse(v); }
export function decNum(v: unknown): number { return decNumSch.parse(v); }
export function decStrOpt(v: unknown): string | undefined { return decStrOptSch.parse(v); }
export function decNumOpt(v: unknown): number | undefined { return decNumOptSch.parse(v); }

// ═══════════════════════════════════════════════════════════════
// Top-level scalar codecs
// ═══════════════════════════════════════════════════════════════

type TopScalarKey = Exclude<
  ScalarKeys<CreateContainerGroupInput>,
  'region' | 'instanceId' | 'description'
>;

const TOP_SCALARS = {
  name: {
    param: 'ContainerGroupName',
    responsePath: 'ContainerGroupName',
    encode: v => v,
    decode: decStr,
  },
  zoneId: {
    param: 'ZoneId',
    responsePath: 'ZoneId',
    encode: v => v,
    decode: decStr,
  },
  cpu: {
    param: 'Cpu',
    responsePath: 'Cpu',
    encode: String,
    decode: decNum,
  },
  memory: {
    param: 'Memory',
    responsePath: 'Memory',
    encode: String,
    decode: decNum,
  },
  restartPolicy: {
    param: 'RestartPolicy',
    responsePath: 'RestartPolicy',
    encode: v => v,
    decode: v => z.string().parse(v ?? 'Always'),
  },
  gpu: {
    param: 'GpuSpecs',
    responsePath: 'Gpu',
    encode: () => { throw new Error('GPU encode must go through buildGpuParam()'); },
    decode: decNumOpt,
  },
  gpuType: {
    param: 'GpuSpecs',
    responsePath: 'InstanceType',
    encode: () => { throw new Error('GPU encode must go through buildGpuParam()'); },
    decode: decStr,
  },
} satisfies CodecTable<CreateContainerGroupInput, TopScalarKey>;

function buildGpuParam(input: CreateContainerGroupInput): Record<string, string> {
  if (!input.gpu || input.gpu <= 0) return {};
  return {
    GpuSpecs: JSON.stringify([{
      Count: input.gpu,
      Type: input.gpuType ?? 'nvidia.com/gpu',
    }]),
  };
}

// ═══════════════════════════════════════════════════════════════
// Container scalar codecs
// ═══════════════════════════════════════════════════════════════

type ContainerScalarKey = ScalarKeys<ContainerCreateConfig>;

const CONTAINER_SCALARS = {
  name: {
    param: 'Name',
    responsePath: 'Name',
    encode: v => v,
    decode: decStr,
  },
  image: {
    param: 'Image',
    responsePath: 'Image',
    encode: v => v,
    decode: decStr,
  },
  imagePullPolicy: {
    param: 'ImagePullPolicy',
    responsePath: 'ImagePullPolicy',
    encode: v => v,
    decode: decStr,
  },
  tty: {
    param: 'Tty',
    responsePath: 'Tty',
    encode: v => v ? 'true' : 'false',
    decode: v => v === 'true' || v === true,
  },
  stdin: {
    param: 'Stdin',
    responsePath: 'Stdin',
    encode: v => v ? 'true' : 'false',
    decode: v => v === 'true' || v === true,
  },
  networkMode: {
    param: 'NetworkMode',
    responsePath: 'NetworkMode',
    encode: v => v,
    decode: decStr,
  },
} satisfies CodecTable<ContainerCreateConfig, ContainerScalarKey>;

function buildContainerCompound(c: ContainerCreateConfig, pfx: string): Record<string, string> {
  const p: Record<string, string> = {};
  if (c.resources?.limits) {
    p[`${pfx}.Cpu`] = String(c.resources.limits.cpu);
    p[`${pfx}.Memory`] = String(c.resources.limits.memory);
  }
  return p;
}

// ═══════════════════════════════════════════════════════════════
// Env var spec (nested inside container)
// ═══════════════════════════════════════════════════════════════

interface EnvItem {
  readonly name: string;
  readonly value?: string | undefined;
  readonly valueFrom?: EnvVar['valueFrom'] | undefined;
}

const ENV_SCALARS = {
  name: {
    param: 'Key',
    responsePath: 'Key',
    encode: (v: unknown): string => z.string().parse(v),
    decode: decStr,
  },
  value: {
    param: 'Value',
    responsePath: 'Value',
    encode: (v: unknown): string => z.string().parse(v),
    decode: decStr,
  },
  valueFrom: {
    param: 'FieldRefFieldPath',
    responsePath: 'FieldRefFieldPath',
    encode: (v: unknown): string => {
      const parsed = z.object({ fieldRef: z.object({ fieldPath: z.string() }).optional() }).parse(v);
      return parsed.fieldRef?.fieldPath ?? '';
    },
    decode: v => v ? z.string().parse(v) : '',
  },
} satisfies Record<string, NestedCodec>;

const ENV_SPEC: NestedSpec<EnvItem, typeof ENV_SCALARS> = {
  prefix: (j) => `EnvironmentVar.${String(j + 1)}`,
  collection: (_input) => undefined,
  scalars: ENV_SCALARS,
};

function buildEnvParams(env: readonly EnvVar[] | undefined, basePfx: string): Record<string, string> {
  const p: Record<string, string> = {};
  if (!env?.length) return p;
  env.forEach((e, j) => {
    const epfx = `${basePfx}.${ENV_SPEC.prefix(j)}`;
    p[`${epfx}.Key`] = e.name;
    if (e.value !== undefined) {
      p[`${epfx}.Value`] = e.value;
    } else if (e.valueFrom?.fieldRef) {
      p[`${epfx}.FieldRefFieldPath`] = e.valueFrom.fieldRef.fieldPath;
    }
  });
  return p;
}

function parseEnv(vars: EciEnvItem[] | undefined): Record<string, string> {
  if (!vars?.length) return {};
  const out: Record<string, string> = {};
  for (const e of vars) {
    if (e.Key) out[e.Key] = e.Value ?? '';
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// Port spec (nested inside container)
// ═══════════════════════════════════════════════════════════════

type PortScalarKey = ScalarKeys<ContainerPortConfig>;

const PORT_SCALARS = {
  containerPort: {
    param: 'Port',
    responsePath: 'Port',
    encode: String,
    decode: decNum,
  },
  hostPort: {
    param: 'HostPort',
    responsePath: 'HostPort',
    encode: String,
    decode: decNum,
  },
  protocol: {
    param: 'Protocol',
    responsePath: 'Protocol',
    encode: v => v,
    decode: v => z.string().optional().parse(v) ?? 'tcp',
  },
} satisfies CodecTable<ContainerPortConfig, PortScalarKey>;

function buildPortParams(ports: readonly ContainerPortConfig[] | undefined, basePfx: string): Record<string, string> {
  const p: Record<string, string> = {};
  if (!ports?.length) return p;
  ports.forEach((port, i) => {
    const ppfx = `${basePfx}.Port.${String(i + 1)}`;
    p[`${ppfx}.Port`] = String(port.containerPort);
    if (port.protocol) p[`${ppfx}.Protocol`] = port.protocol;
    if (port.hostPort !== undefined) p[`${ppfx}.HostPort`] = String(port.hostPort);
  });
  return p;
}

// ═══════════════════════════════════════════════════════════════
// Probe spec (shared by livenessProbe / readinessProbe / startupProbe)
// ═══════════════════════════════════════════════════════════════

type ProbeScalarKey = Exclude<ScalarKeys<ProbeSpec>, 'httpGet' | 'exec' | 'tcpSocket'>;

const PROBE_SCALARS = {
  initialDelaySeconds: {
    param: 'InitialDelaySeconds',
    responsePath: 'InitialDelaySeconds',
    encode: String,
    decode: decNum,
  },
  timeoutSeconds: {
    param: 'TimeoutSeconds',
    responsePath: 'TimeoutSeconds',
    encode: String,
    decode: decNum,
  },
  periodSeconds: {
    param: 'PeriodSeconds',
    responsePath: 'PeriodSeconds',
    encode: String,
    decode: decNum,
  },
  successThreshold: {
    param: 'SuccessThreshold',
    responsePath: 'SuccessThreshold',
    encode: String,
    decode: decNum,
  },
  failureThreshold: {
    param: 'FailureThreshold',
    responsePath: 'FailureThreshold',
    encode: String,
    decode: decNum,
  },
} satisfies CodecTable<ProbeSpec, ProbeScalarKey>;

function buildProbeParams(
  probe: ProbeSpec | undefined,
  pfx: string,
  probeType: string,
): Record<string, string> {
  const p: Record<string, string> = {};
  if (!probe) return p;
  const base = `${pfx}.${probeType}`;

  if (probe.tcpSocket) {
    p[`${base}.TcpSocket.Port`] = String(probe.tcpSocket.port);
  }
  if (probe.httpGet) {
    p[`${base}.HttpGet.Path`] = probe.httpGet.path;
    p[`${base}.HttpGet.Port`] = String(probe.httpGet.port);
    if (probe.httpGet.scheme) p[`${base}.HttpGet.Scheme`] = probe.httpGet.scheme;
  }
  if (probe.exec) {
    p[`${base}.Exec.Commands`] = probe.exec.command.join(' ');
  }
  if (probe.initialDelaySeconds !== undefined) p[`${base}.InitialDelaySeconds`] = String(probe.initialDelaySeconds);
  if (probe.periodSeconds !== undefined) p[`${base}.PeriodSeconds`] = String(probe.periodSeconds);
  if (probe.timeoutSeconds !== undefined) p[`${base}.TimeoutSeconds`] = String(probe.timeoutSeconds);
  if (probe.failureThreshold !== undefined) p[`${base}.FailureThreshold`] = String(probe.failureThreshold);
  if (probe.successThreshold !== undefined) p[`${base}.SuccessThreshold`] = String(probe.successThreshold);
  return p;
}

export function parseProbe(raw: EciProbeItem | undefined): ProbeSpec | undefined {
  if (!raw) return undefined;
  const result: ProbeSpec = {
    ...(raw.InitialDelaySeconds !== undefined ? { initialDelaySeconds: raw.InitialDelaySeconds } : {}),
    ...(raw.PeriodSeconds !== undefined ? { periodSeconds: raw.PeriodSeconds } : {}),
    ...(raw.TimeoutSeconds !== undefined ? { timeoutSeconds: raw.TimeoutSeconds } : {}),
    ...(raw.FailureThreshold !== undefined ? { failureThreshold: raw.FailureThreshold } : {}),
    ...(raw.SuccessThreshold !== undefined ? { successThreshold: raw.SuccessThreshold } : {}),
    ...(raw.TcpSocket?.Port !== undefined ? { tcpSocket: { port: raw.TcpSocket.Port } } : {}),
    ...(raw.HttpGet ? { httpGet: { path: raw.HttpGet.Path ?? '/', port: raw.HttpGet.Port ?? 80, ...(raw.HttpGet.Scheme ? { scheme: raw.HttpGet.Scheme } : {}) } } : {}),
    ...(raw.Exec?.Commands?.length ? { exec: { command: raw.Exec.Commands } } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

// ═══════════════════════════════════════════════════════════════
// Volume spec (nested inside CreateContainerGroupInput)
// ═══════════════════════════════════════════════════════════════

type VolumeScalarKey = ScalarKeys<VolumeConfigInput>;

const VOLUME_SCALARS = {
  id: {
    param: 'Name',
    responsePath: 'Name',
    encode: v => v,
    decode: decStr,
  },
  type: {
    param: 'Type',
    responsePath: 'Type',
    encode: v => v,
    decode: decStr,
  },
} satisfies CodecTable<VolumeConfigInput, VolumeScalarKey>;

function strVal(val: unknown): string {
  return z.string().parse(val);
}

function buildVolumeCompound(v: VolumeConfigInput, pfx: string): Record<string, string> {
  const p: Record<string, string> = {};
  const opts = (v.options ?? {});

  // ── EmptyDir Volume ──
  // ECI API: Volume.N.Type = "EmptyDirVolume"
  //          Volume.N.EmptyDirVolume.Medium = "" | "Memory" | "LocalRaid0"
  //          Volume.N.EmptyDirVolume.SizeLimit = "512Mi"
  if (v.type === 'EmptyDirVolume' || opts.sizeLimit !== undefined) {
    p[`${pfx}.Type`] = 'EmptyDirVolume';
    const medium = strVal(opts.medium ?? '');
    if (medium) {
      p[`${pfx}.EmptyDirVolume.Medium`] = medium;
    }
    if (opts.sizeLimit !== undefined) {
      p[`${pfx}.EmptyDirVolume.SizeLimit`] = strVal(opts.sizeLimit);
    }
    return p;
  }

  if (opts.server) {
    p[`${pfx}.NFSVolume.Server`] = strVal(opts.server);
    p[`${pfx}.NFSVolume.Path`] = strVal(opts.path ?? '');
    if (opts.readOnly) p[`${pfx}.NFSVolume.ReadOnly`] = 'true';
  }
  if (opts.bucket) {
    p[`${pfx}.Type`] = 'OSSVolume';
    p[`${pfx}.OSSVolume.Bucket`] = strVal(opts.bucket);
    if (opts.path) p[`${pfx}.OSSVolume.Path`] = strVal(opts.path);
    if (opts.readOnly) p[`${pfx}.OSSVolume.ReadOnly`] = 'true';
    if (opts.endpoint) p[`${pfx}.OSSVolume.Endpoint`] = strVal(opts.endpoint);
  }
  if (opts.diskId) {
    p[`${pfx}.DiskVolume.DiskId`] = strVal(opts.diskId);
    p[`${pfx}.DiskVolume.FsType`] = strVal(opts.fsType ?? 'ext4');
    if (opts.sizeGiB !== undefined) p[`${pfx}.DiskVolume.DiskSize`] = String(z.number().parse(opts.sizeGiB));
    if (opts.diskCategory) p[`${pfx}.DiskVolume.DiskCategory`] = strVal(opts.diskCategory);
    if (opts.readOnly) p[`${pfx}.DiskVolume.ReadOnly`] = 'true';
    if (opts.deleteWithInstance) p[`${pfx}.DiskVolume.DeleteWithInstance`] = 'true';
  }
  if (v.type === 'ConfigMapVolume' || opts.configMapName) {
    const name = strVal(opts.configMapName ?? opts.name ?? '');
    const itemsSchema = z.array(z.object({ key: z.string(), path: z.string(), mode: z.number().optional() })).optional();
    const items = itemsSchema.parse(opts.items) ?? [];
    p[`${pfx}.ConfigMapVolume.Name`] = name;
    items.forEach((item, j) => {
      p[`${pfx}.ConfigMapVolume.Items.${String(j + 1)}.Key`] = item.key;
      p[`${pfx}.ConfigMapVolume.Items.${String(j + 1)}.Path`] = item.path;
      if (item.mode !== undefined) p[`${pfx}.ConfigMapVolume.Items.${String(j + 1)}.Mode`] = String(item.mode);
    });
  }
  if (v.type === 'SecretVolume' || opts.secretName) {
    const name = strVal(opts.secretName ?? opts.name ?? '');
    const itemsSchema = z.array(z.object({ key: z.string(), path: z.string(), mode: z.number().optional() })).optional();
    const items = itemsSchema.parse(opts.items) ?? [];
    p[`${pfx}.SecretVolume.SecretName`] = name;
    items.forEach((item, j) => {
      p[`${pfx}.SecretVolume.Items.${String(j + 1)}.Key`] = item.key;
      p[`${pfx}.SecretVolume.Items.${String(j + 1)}.Path`] = item.path;
      if (item.mode !== undefined) p[`${pfx}.SecretVolume.Items.${String(j + 1)}.Mode`] = String(item.mode);
    });
  }
  return p;
}

function parseVolumes(vols: EciVolumeItem[] | undefined): VolumeRuntimeInfo[] {
  if (!vols?.length) return [];
  return vols.map(v => ({
    name: v.Name ?? '',
    type: v.Type ?? '',
    ...(v.NFSVolume ? {
      nfs: { server: v.NFSVolume.Server ?? '', path: v.NFSVolume.Path ?? '', readOnly: v.NFSVolume.ReadOnly === true },
    } : {}),
    ...(v.EmptyDirVolume ? {
      emptyDir: { sizeLimit: v.EmptyDirVolume.SizeLimit ?? '', medium: v.EmptyDirVolume.Medium },
    } : {}),
  }));
}

// ═══════════════════════════════════════════════════════════════
// Tag spec
// ═══════════════════════════════════════════════════════════════

function buildTagParams(input: CreateContainerGroupInput): Record<string, string> {
  const p: Record<string, string> = {};
  if (!input.tags?.length) return p;
  input.tags.forEach((t, i) => {
    p[`Tag.${String(i + 1)}.Key`] = t.key;
    p[`Tag.${String(i + 1)}.Value`] = t.value;
  });
  return p;
}

function parseTags(tags: EciTagItem[] | undefined): { key: string; value: string }[] {
  if (!tags?.length) return [];
  return tags.map(t => ({ key: t.Key ?? '', value: t.Value ?? '' }));
}

// ═══════════════════════════════════════════════════════════════
// Write engine: CreateContainerGroupInput → flat RPC params
// ═══════════════════════════════════════════════════════════════

export function buildCreateParams(
  input: CreateContainerGroupInput,
  opts?: { partial?: boolean },
): Record<string, string> {
  const partial = opts?.partial ?? false;
  let p: Record<string, string> = {};

  if (!partial) {
    p.RegionId = String(input.region);
  }

  // ── Top-level scalars (explicit per-field — type-safe, no casts) ──
  p[TOP_SCALARS.name.param] = TOP_SCALARS.name.encode(input.name);
  if (input.zoneId !== undefined) p[TOP_SCALARS.zoneId.param] = TOP_SCALARS.zoneId.encode(input.zoneId);
  p[TOP_SCALARS.cpu.param] = TOP_SCALARS.cpu.encode(input.cpu);
  p[TOP_SCALARS.memory.param] = TOP_SCALARS.memory.encode(input.memory);
  p[TOP_SCALARS.restartPolicy.param] = TOP_SCALARS.restartPolicy.encode(input.restartPolicy);

  if (!partial || input.gpu !== undefined) {
    p = { ...p, ...buildGpuParam(input) };
  }

  // ── Containers ──
  if (input.containers.length > 0) {
    input.containers.forEach((c, i) => {
      const cpfx = `Container.${String(i + 1)}`;

      // Container scalars — explicit per-field, type-safe no casts
      p[`${cpfx}.${CONTAINER_SCALARS.name.param}`] = CONTAINER_SCALARS.name.encode(c.name);
      p[`${cpfx}.${CONTAINER_SCALARS.image.param}`] = CONTAINER_SCALARS.image.encode(c.image);
      if (c.imagePullPolicy !== undefined) p[`${cpfx}.${CONTAINER_SCALARS.imagePullPolicy.param}`] = CONTAINER_SCALARS.imagePullPolicy.encode(c.imagePullPolicy);
      if (c.networkMode !== undefined) p[`${cpfx}.${CONTAINER_SCALARS.networkMode.param}`] = CONTAINER_SCALARS.networkMode.encode(c.networkMode);
      if (c.tty !== undefined) p[`${cpfx}.${CONTAINER_SCALARS.tty.param}`] = CONTAINER_SCALARS.tty.encode(c.tty);
      if (c.stdin !== undefined) p[`${cpfx}.${CONTAINER_SCALARS.stdin.param}`] = CONTAINER_SCALARS.stdin.encode(c.stdin);

      if (c.command?.length) p[`${cpfx}.Command`] = c.command.join(' ');
      if (c.args?.length) p[`${cpfx}.Args`] = c.args.join(' ');

      p = { ...p, ...buildContainerCompound(c, cpfx) };
      p = { ...p, ...buildEnvParams(c.env, cpfx) };
      p = { ...p, ...buildPortParams(c.ports, cpfx) };

      p = { ...p, ...buildProbeParams(c.livenessProbe, cpfx, 'LivenessProbe') };
      p = { ...p, ...buildProbeParams(c.readinessProbe, cpfx, 'ReadinessProbe') };
      p = { ...p, ...buildProbeParams(c.startupProbe, cpfx, 'StartupProbe') };

      // ── VolumeMounts ──
      if (c.volumeMounts?.length) {
        c.volumeMounts.forEach((vm, j) => {
          const vmpfx = `${cpfx}.VolumeMount.${String(j + 1)}`;
          p[`${vmpfx}.Name`] = vm.volumeId;
          p[`${vmpfx}.MountPath`] = vm.mountPath;
          if (vm.readOnly) p[`${vmpfx}.ReadOnly`] = 'true';
          if (vm.mountPropagation) p[`${vmpfx}.MountPropagation`] = vm.mountPropagation;
        });
      }
    });
  }

  // ── Volumes ──
  if (input.volumes?.length) {
    input.volumes.forEach((v, i) => {
      const vpfx = `Volume.${String(i + 1)}`;
      p[`${vpfx}.Name`] = v.id;
      p[`${vpfx}.Type`] = v.type;
      p = { ...p, ...buildVolumeCompound(v, vpfx) };
    });
  }

  // ── Secret Mounts ──
  if (input.secretMounts?.length) {
    input.secretMounts.forEach((sm, i) => {
      const spfx = `ConfigFileVolume.${String(i + 1)}`;
      p[`${spfx}.MountPath`] = sm.mountPath;
      p[`${spfx}.Payload`] = sm.data;
      p[`${spfx}.FilePermission`] = String(sm.mode ?? 0o600);
    });
  }

  // ── Network ──
  if (!partial) {
    p.SecurityGroupId = input.network.securityGroupId ?? '';
    if (input.network.subnetIds?.length) {
      p.VSwitchId = input.network.subnetIds.join(',');
      p.ScheduleStrategy = 'VSwitchRandom';
      delete p.ZoneId;
    }
  }

  if (!partial) {
    p.AutoMatchImageCache = 'true';
  }

  if (!partial || input.tags) {
    p = { ...p, ...buildTagParams(input) };
  }

  // ── Extension fields (providerOverrides) ──
  if (input.providerOverrides) {
    const raw = input.providerOverrides;
    const flat = z.record(z.string(), z.unknown()).optional().parse(raw.alibaba) ?? raw;
    const ext = applyExtensionOverrides('alibaba', flat);
    for (const [k, v] of Object.entries(ext)) {
      p[k] = v;
    }
  }

  return p;
}

// ═══════════════════════════════════════════════════════════════
// PodSpec → flat RPC params (v3 direct path — no CreateContainerGroupInput)
// ═══════════════════════════════════════════════════════════════

const PRIORITY_ENV = 'HBI_PRIORITY';

function toContainerCreateConfig(c: ContainerSpec, priority?: number): ContainerCreateConfig {
  const baseEnv = c.env ?? [];
  const env = priority !== undefined
    ? [...baseEnv, { name: PRIORITY_ENV, value: String(priority) }]
    : baseEnv;

  return {
    name: c.name,
    image: c.image,
    command: c.command,
    args: c.args,
    env: env.length > 0 ? env : undefined,
    ports: c.ports,
    volumeMounts: c.volumeMounts,
    livenessProbe: c.livenessProbe,
    readinessProbe: c.readinessProbe,
    startupProbe: c.startupProbe,
    imagePullPolicy: c.imagePullPolicy ?? undefined,
    tty: c.tty ?? undefined,
    stdin: c.stdin ?? undefined,
    networkMode: c.networkMode ?? undefined,
    providerOverrides: c.providerOverrides ?? undefined,
    resources: c.resources !== undefined ? { limits: c.resources.limits } : undefined,
  };
}

function toVolumeConfigInput(v: { readonly id: string; readonly type: string; readonly options?: Record<string, unknown> | undefined }): VolumeConfigInput {
  return { id: v.id, type: v.type, options: v.options };
}

export function buildPodCreateParams(spec: PodSpec, region: string): Record<string, string> {
  let p: Record<string, string> = {};

  p.RegionId = region;

  // ── Top-level fields ──
  p.ContainerGroupName = spec.metadata.name;

  const containers = spec.spec.containers.map(c => toContainerCreateConfig(c, spec.spec.priority));
  const totalCpu = containers.reduce((s, c) => s + (c.resources?.limits?.cpu ?? 0), 0) || 1;
  const totalMem = containers.reduce((s, c) => s + (c.resources?.limits?.memory ?? 0), 0) || 512;
  p.Cpu = String(totalCpu);
  p.Memory = String(totalMem);
  p.RestartPolicy = spec.spec.restartPolicy;

  // GPU
  const totalGpu = containers.reduce((s, c) => s + (c.resources?.limits?.gpu ?? 0), 0);
  if (totalGpu > 0) {
    p.GpuSpecs = JSON.stringify([{ Count: totalGpu, Type: 'nvidia.com/gpu' }]);
  }

  // ── Containers ──
  containers.forEach((c, i) => {
    const cpfx = `Container.${String(i + 1)}`;
    p[`${cpfx}.Name`] = c.name;
    p[`${cpfx}.Image`] = c.image;
    if (c.imagePullPolicy !== undefined) p[`${cpfx}.ImagePullPolicy`] = c.imagePullPolicy;
    if (c.networkMode !== undefined) p[`${cpfx}.NetworkMode`] = c.networkMode;
    if (c.tty !== undefined) p[`${cpfx}.Tty`] = c.tty ? 'true' : 'false';
    if (c.stdin !== undefined) p[`${cpfx}.Stdin`] = c.stdin ? 'true' : 'false';
    if (c.command?.length) p[`${cpfx}.Command`] = c.command.join(' ');
    if (c.args?.length) p[`${cpfx}.Args`] = c.args.join(' ');

    p = { ...p, ...buildContainerCompound(c, cpfx) };
    p = { ...p, ...buildEnvParams(c.env, cpfx) };
    p = { ...p, ...buildPortParams(c.ports, cpfx) };
    p = { ...p, ...buildProbeParams(c.livenessProbe, cpfx, 'LivenessProbe') };
    p = { ...p, ...buildProbeParams(c.readinessProbe, cpfx, 'ReadinessProbe') };
    p = { ...p, ...buildProbeParams(c.startupProbe, cpfx, 'StartupProbe') };

    // ── VolumeMounts ──
    if (c.volumeMounts?.length) {
      c.volumeMounts.forEach((vm, j) => {
        const vmpfx = `${cpfx}.VolumeMount.${String(j + 1)}`;
        p[`${vmpfx}.Name`] = vm.volumeId;
        p[`${vmpfx}.MountPath`] = vm.mountPath;
        if (vm.readOnly) p[`${vmpfx}.ReadOnly`] = 'true';
        if (vm.mountPropagation) p[`${vmpfx}.MountPropagation`] = vm.mountPropagation;
      });
    }
  });

  // ── InitContainers ──
  const initContainers = spec.spec.initContainers?.map(c => toContainerCreateConfig(c)) ?? [];
  initContainers.forEach((c, i) => {
    const ipfx = `InitContainer.${String(i + 1)}`;
    p[`${ipfx}.Name`] = c.name;
    p[`${ipfx}.Image`] = c.image;
    if (c.command?.length) p[`${ipfx}.Command`] = c.command.join(' ');
    if (c.args?.length) p[`${ipfx}.Args`] = c.args.join(' ');
    p = { ...p, ...buildContainerCompound(c, ipfx) };
    p = { ...p, ...buildEnvParams(c.env, ipfx) };
    p = { ...p, ...buildProbeParams(c.livenessProbe, ipfx, 'LivenessProbe') };
  });

  // ── Volumes ──
  if (spec.spec.volumes?.length) {
    spec.spec.volumes.forEach((v, i) => {
      const vpfx = `Volume.${String(i + 1)}`;
      p[`${vpfx}.Name`] = v.id;
      p[`${vpfx}.Type`] = v.type;
      p = { ...p, ...buildVolumeCompound(toVolumeConfigInput(v), vpfx) };
    });
  }

  // ── Secret Mounts ──
  if (spec.spec.secretMounts?.length) {
    spec.spec.secretMounts.forEach((sm, i) => {
      const spfx = `ConfigFileVolume.${String(i + 1)}`;
      p[`${spfx}.MountPath`] = sm.mountPath;
      p[`${spfx}.Payload`] = sm.data;
      p[`${spfx}.FilePermission`] = String(sm.mode ?? 0o600);
    });
  }

  // ── Tags (from labels) ──
  if (spec.metadata.labels) {
    const entries = Object.entries(spec.metadata.labels);
    entries.forEach(([k, v], i) => {
      p[`Tag.${String(i + 1)}.Key`] = k;
      p[`Tag.${String(i + 1)}.Value`] = v;
    });
  }

  // ── DNS config ──
  if (spec.spec.dnsConfig) {
    const dns = spec.spec.dnsConfig;
    if (dns.nameservers?.length) {
      dns.nameservers.forEach((ns, i) => { p[`DnsConfig.NameServer.${String(i + 1)}`] = ns; });
    }
    if (dns.searches?.length) {
      dns.searches.forEach((s, i) => { p[`DnsConfig.Search.${String(i + 1)}`] = s; });
    }
    if (dns.options?.length) {
      dns.options.forEach((o, i) => {
        p[`DnsConfig.Option.${String(i + 1)}.Name`] = o.name;
        if (o.value !== undefined) p[`DnsConfig.Option.${String(i + 1)}.Value`] = o.value;
      });
    }
  }

  // ── HostAliases ──
  if (spec.spec.hostAliases?.length) {
    spec.spec.hostAliases.forEach((ha, i) => {
      p[`HostAliase.${String(i + 1)}.Ip`] = ha.ip;
      ha.hostnames.forEach((h, j) => { p[`HostAliase.${String(i + 1)}.Hostname.${String(j + 1)}`] = h; });
    });
  }

  // ── TerminationGracePeriod ──
  if (spec.spec.terminationGracePeriodSeconds !== undefined) {
    p.TerminationGracePeriodSeconds = String(spec.spec.terminationGracePeriodSeconds);
  }

  // ── Network defaults ──
  p.AutoMatchImageCache = 'true';

  // ── Extension fields (providerOverrides) ──
  if (spec.providerOverrides) {
    const raw = spec.providerOverrides;
    const flat = z.record(z.string(), z.unknown()).optional().parse(raw.alibaba) ?? raw;
    const ext = applyExtensionOverrides('alibaba', flat);
    for (const [k, v] of Object.entries(ext)) {
      p[k] = v;
    }
  }

  return p;
}

// ═══════════════════════════════════════════════════════════════
// Read engine: ECI DescribeContainerGroups response → ContainerGroupRuntime
// ═══════════════════════════════════════════════════════════════

function gpuModelFromInstanceType(instanceType: string | undefined): string | undefined {
  if (!instanceType) return undefined;
  const prefix = instanceType.split('.')[0] ?? '';
  const map: Record<string, string> = {
    gn5: 'NVIDIA P100',   gn5i: 'NVIDIA P4',
    gn6e: 'NVIDIA V100',  gn6v: 'NVIDIA T4',
    gn7: 'NVIDIA A100',   gn7i: 'NVIDIA A10',
    gn8: 'NVIDIA H100',
  };
  for (const [key, model] of Object.entries(map)) {
    if (prefix === key || prefix.startsWith(key)) return model;
  }
  return undefined;
}

function parseAssociatedResources(raw: EciAssociatedResource[] | undefined): AssociatedResource[] {
  if (!raw?.length) return [];
  return raw.map(r => ({
    type: 'eip',
    resourceId: r.ResourceId ?? '',
    ...(r.Ip !== undefined ? { ip: r.Ip } : {}),
    ...(r.Bandwidth !== undefined ? { bandwidth: r.Bandwidth } : {}),
    ...(r.Isp !== undefined ? { isp: r.Isp } : {}),
    ...(r.Status !== undefined ? { status: r.Status } : {}),
  }));
}

function parseEvents(raw: EciEventItem[] | undefined): ContainerGroupRuntimeEvent[] {
  if (!raw?.length) return [];
  return raw.map(e => ({
    reason: e.Reason ?? '',
    type: (e.Type === 'Warning' ? 'Warning' : 'Normal'),
    message: e.Message ?? '',
    count: e.Count ?? 0,
    ...(e.LastTimestamp ? { lastTimestamp: e.LastTimestamp } : {}),
  }));
}

const containerGroupStatusSchema = z.enum([
  'Pending', 'Scheduling', 'ScheduleFailed', 'Running',
  'Succeeded', 'Failed', 'Restarting', 'Updating', 'Terminating',
  'Expiring', 'Expired', 'Deleted',
]);

const ociContainerStatusSchema = z.enum([
  'creating', 'created', 'running', 'stopped', 'paused', 'error', 'deleted',
]);

export function parseContainerGroup(item: EciDescribeResponse): ContainerGroupRuntime {
  const containers: EciContainerItem[] = item.Containers ?? [];
  const zoneId = item.ZoneId ? createZoneId(item.ZoneId, 'alibaba') : undefined;
  const gpu = item.Gpu ? z.coerce.number().parse(item.Gpu) : undefined;
  const gpuModel = gpuModelFromInstanceType(item.InstanceType);
  const ephemeral = item.EphemeralStorage ? z.number().parse(item.EphemeralStorage) : undefined;

  return {
    providerId: item.ContainerGroupId ?? '',
    name: item.ContainerGroupName ?? '',
    status: containerGroupStatusSchema.parse(item.Status ?? 'Pending'),
    regionId: createRegionId(item.RegionId ?? 'cn-hangzhou'),
    cpu: item.Cpu ?? 0,
    memory: item.Memory ?? 0,
    network: {
      ...(item.IntranetIp ?? item.PrivateIp ? { privateIp: item.IntranetIp ?? item.PrivateIp ?? '' } : {}),
      ...(item.VpcId ? { vpcId: item.VpcId } : {}),
      ...(item.VSwitchId ? { subnetId: item.VSwitchId } : {}),
      ...(item.SecurityGroupId ? { securityGroupId: item.SecurityGroupId } : {}),
      ...(item.EniInstanceId ? { eniId: item.EniInstanceId } : {}),
    },
    associatedResources: parseAssociatedResources(item.AssociatedResources),
    restartPolicy: item.RestartPolicy ?? 'Always',
    containers: containers.map(c => ({
      id: createContainerId(c.ContainerId ?? 'ctr-unknown'),
      name: c.Name ?? '',
      image: c.Image ?? '',
      args: c.Args ?? [],
      env: parseEnv(c.EnvironmentVars),
      workingDir: c.WorkingDir ?? '',
      status: ociContainerStatusSchema.parse(c.Status?.toLowerCase() ?? 'creating'),
      alive: c.Status === 'Running',
      createdAt: c.CreationTime ?? '',
      startedAt: c.StartedAt ?? undefined,
      finishedAt: c.FinishedAt ?? undefined,
      exitCode: c.ExitCode ?? undefined,
      labels: {},
      annotations: {},
      mounts: [],
      resources: (c.Cpu || c.Memory || c.Gpu) ? {
        cpu: c.Cpu ?? 0,
        memory: c.Memory ?? 0,
        ...(c.Gpu ? { gpu: z.coerce.number().parse(c.Gpu) } : {}),
      } : undefined,
      health: { status: c.Status === 'Running' ? 'healthy' : 'starting' },
    })),
    volumes: parseVolumes(item.Volumes),
    events: parseEvents(item.Events),
    tags: parseTags(item.Tags),
    ...(zoneId ? { zoneId } : {}),
    ...(item.CreationTime ? { creationTime: item.CreationTime } : {}),
    ...(item.ExpiredTime ? { expiredTime: item.ExpiredTime } : {}),
    ...(item.InstanceType ? { instanceType: item.InstanceType } : {}),
    ...(item.SpotStrategy ? { spotStrategy: item.SpotStrategy } : {}),
    ...(gpu !== undefined ? { gpu } : {}),
    ...(gpuModel ? { gpuModel } : {}),
    ...(item.Discount !== undefined ? { discount: item.Discount } : {}),
    ...(ephemeral !== undefined ? { ephemeralStorageGiB: ephemeral } : {}),
  };
}

// ═══════════════════════════════════════════════════════════════
// Compile-time + init-time codec integrity
// ═══════════════════════════════════════════════════════════════

export function validateCodecIntegrity(): { ok: boolean; broken: string[] } {
  const tables: Record<string, Record<string, unknown>> = {
    TOP_SCALARS,
    CONTAINER_SCALARS,
    PROBE_SCALARS,
    PORT_SCALARS,
    VOLUME_SCALARS,
  };

  const codecSchema = z.object({ encode: z.function(), decode: z.function(), param: z.string() });

  const broken: string[] = [];
  for (const [name, table] of Object.entries(tables)) {
    for (const [key, codec] of Object.entries(table)) {
      if (typeof codec !== 'object' || codec === null) {
        broken.push(`${name}.${key}: not an object`);
        continue;
      }
      try { codecSchema.pick({ encode: true }).parse(codec); } catch { broken.push(`${name}.${key}: encode is not a function`); }
      try { codecSchema.pick({ decode: true }).parse(codec); } catch { broken.push(`${name}.${key}: decode is not a function`); }
      try { codecSchema.pick({ param: true }).parse(codec); } catch { broken.push(`${name}.${key}: param is not a string`); }
    }
  }

  if (broken.length > 0) {
    console.error('[eci-codec] Codec integrity failure:', broken.join('; '));
  }
  return { ok: broken.length === 0, broken };
}

const _INTEGRITY = validateCodecIntegrity();
void _INTEGRITY;

void PORT_SCALARS;
void PROBE_SCALARS;
void VOLUME_SCALARS;
void ENV_SPEC;
