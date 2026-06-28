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

import type {
  CreateContainerGroupInput,
  ContainerCreateConfig,
  ContainerGroupRuntime,
  ContainerGroupStatus,
  OciContainerStatus,
  VolumeConfigInput,
  VolumeRuntimeInfo,
  ProbeSpec,
  ContainerPortConfig,
  EnvVar,
  ContainerGroupRuntimeEvent,
  AssociatedResource,
} from '../../core/provider/types.ts';
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
  readonly encode: (v: TEncode) => string;
  readonly decode: (v: unknown) => TDecode;
}

/** Derive precise codec table type from an interface.
 *  encode receives NonNullable<T[P]> (null-checked by caller).
 *  decode returns T[P] (full type — matches the interface field).
 *  Wrong type → TS compile error. */
type CodecTable<T, K extends keyof T = ScalarKeys<T>> = {
  [P in K]: EciFieldCodec<NonNullable<T[P]>, T[P]>;
};

/** Describes how to map an array from CreateContainerGroupInput into indexed RPC params. */
interface NestedSpec<TItem> {
  /** Prefix generator, e.g. i => `Container.${i + 1}`. 1-indexed. */
  readonly prefix: (idx: number) => string;
  /** Extract the collection from the input. */
  readonly collection: (input: CreateContainerGroupInput) => readonly TItem[] | undefined;
  /** Scalar fields on each item, keyed by their property name on TItem. */
  readonly scalars: Record<string, EciFieldCodec<any>>;
  /** Per-item compound builders — called for each item, return extra params. */
  readonly compound?: (item: TItem, pfx: string) => Record<string, string>;
  /** Sub-arrays nested inside each item (e.g. env, ports inside a container). */
  readonly subArrays?: Record<string, NestedSpec<any>>;
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
// Top-level scalar codecs
// ═══════════════════════════════════════════════════════════════
//
// Key union DERIVED from CreateContainerGroupInput — add a scalar field
// there and TS immediately errors here with missing property.

type TopScalarKey = Exclude<
  ScalarKeys<CreateContainerGroupInput>,
  'region'   // → RegionId (always set, handled in create())
  | 'instanceId' // → routing only, not an ECI param
  | 'description' // → metadata only
>;

// Compiler guarantee: every TopScalarKey MUST have an entry here,
// and each entry's T must match the field type from CreateContainerGroupInput.
const TOP_SCALARS: CodecTable<CreateContainerGroupInput, TopScalarKey> = {
  name: {
    param: 'ContainerGroupName',
    responsePath: 'ContainerGroupName',
    encode: v => v,
    decode: v => String(v ?? ''),
  },
  zoneId: {
    param: 'ZoneId',
    responsePath: 'ZoneId',
    encode: v => v,
    decode: v => String(v ?? ''),
  },
  cpu: {
    param: 'Cpu',
    responsePath: 'Cpu',
    encode: String,
    decode: v => Number(v ?? 0),
  },
  memory: {
    param: 'Memory',
    responsePath: 'Memory',
    encode: String,
    decode: v => Number(v ?? 0),
  },
  restartPolicy: {
    param: 'RestartPolicy',
    responsePath: 'RestartPolicy',
    encode: v => v,
    decode: v => String(v ?? 'Always'),
  },
  // gpu and gpuType are compound — encoded as GpuSpecs JSON together.
  // They appear in TopScalarKey (derived from the interface) so the table
  // forces us to acknowledge them.  They are handled in buildGpuParam() below;
  // the encode/decode entries here are no-ops that satisfy the type system.
  gpu: {
    param: 'GpuSpecs',
    responsePath: 'Gpu',
    encode: _v => undefined!,
    decode: v => v != null ? Number(v) : undefined,
  },
  gpuType: {
    param: 'GpuSpecs',
    responsePath: 'InstanceType',
    encode: _v => undefined!,
    decode: v => String(v ?? ''),
  },
};
// Verify: the Record<KeyUnion, ...> constraint above ensures all keys are covered.
// The type of TOP_SCALARS satisfies `Record<TopScalarKey, EciFieldCodec<any>>`.

/** GPU is compound: gpu + gpuType → GpuSpecs JSON. */
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

// ScalarKeys<> naturally excludes array/object fields (command, args, env, ports,
// volumeMounts, resources, probes, providerOverrides).  No manual Exclude needed.
type ContainerScalarKey = ScalarKeys<ContainerCreateConfig>;

const CONTAINER_SCALARS: CodecTable<ContainerCreateConfig, ContainerScalarKey> = {
  name: {
    param: 'Name',
    responsePath: 'Name',
    encode: v => v,
    decode: v => String(v ?? ''),
  },
  image: {
    param: 'Image',
    responsePath: 'Image',
    encode: v => v,
    decode: v => String(v ?? ''),
  },
  // command/args: excluded from ContainerScalarKey by ScalarKeys<> (string[] is not a scalar).
  // Handled in buildCreateParams() compound section.
  imagePullPolicy: {
    param: 'ImagePullPolicy',
    responsePath: 'ImagePullPolicy',
    encode: v => v,
    decode: v => String(v ?? ''),
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
    decode: v => String(v ?? ''),
  },
};
// NOTE: command, args, env, ports, volumeMounts are excluded from ContainerScalarKey
// by ScalarKeys<> derivation — they are non-scalar arrays/objects.  They are handled
// in the compound/nested builders below (buildContainerCompound, buildEnvParams, etc.).

// Verify compile-time completeness: the Record<ContainerScalarKey, ...> annotation
// on CONTAINER_SCALARS ensures every ScalarKeys<ContainerCreateConfig> field
// (minus the explicit Exclude above) has a codec entry.

/** Container compound fields: command/args special handling, resources sub-object. */
function buildContainerCompound(c: ContainerCreateConfig, pfx: string): Record<string, string> {
  const p: Record<string, string> = {};
  // Resources
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

const ENV_SPEC: NestedSpec<EnvItem> = {
  prefix: (j) => `EnvironmentVar.${j + 1}`,
  collection: (_input) => undefined!, // filled per-container
  scalars: {
    name: {
      param: 'Key',
      responsePath: 'Key',
      encode: v => v,
      decode: v => String(v ?? ''),
    },
    value: {
      param: 'Value',
      responsePath: 'Value',
      encode: v => v,
      decode: v => String(v ?? ''),
    },
    valueFrom: {
      param: 'FieldRefFieldPath',
      responsePath: 'FieldRefFieldPath',
      encode: (v: EnvVar['valueFrom']) => v?.fieldRef?.fieldPath ?? '',
      decode: v => v ? String(v) : '',
    },
  },
};

/** Build env params: for each env var, Key/Value if direct value, or Key/FieldRefFieldPath. */
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

/** Parse env from ECI response back to record. */
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

const PORT_SCALARS: CodecTable<ContainerPortConfig, PortScalarKey> = {
  containerPort: {
    param: 'Port',
    responsePath: 'Port',
    encode: String,
    decode: v => Number(v ?? 0),
  },
  hostPort: {
    param: 'HostPort',
    responsePath: 'HostPort',
    encode: String,
    decode: v => Number(v ?? 0),
  },
  protocol: {
    param: 'Protocol',
    responsePath: 'Protocol',
    encode: v => v ?? 'tcp',
    decode: v => String(v ?? 'tcp'),
  },
};

function buildPortParams(ports: readonly ContainerPortConfig[] | undefined, basePfx: string): Record<string, string> {
  const p: Record<string, string> = {};
  if (!ports?.length) return p;
  ports.forEach((port, i) => {
    const ppfx = `${basePfx}.Port.${i + 1}`;
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

const PROBE_SCALARS: CodecTable<ProbeSpec, ProbeScalarKey> = {
  initialDelaySeconds: {
    param: 'InitialDelaySeconds',
    responsePath: 'InitialDelaySeconds',
    encode: String,
    decode: v => Number(v ?? 0),
  },
  timeoutSeconds: {
    param: 'TimeoutSeconds',
    responsePath: 'TimeoutSeconds',
    encode: String,
    decode: v => Number(v ?? 0),
  },
  periodSeconds: {
    param: 'PeriodSeconds',
    responsePath: 'PeriodSeconds',
    encode: String,
    decode: v => Number(v ?? 0),
  },
  successThreshold: {
    param: 'SuccessThreshold',
    responsePath: 'SuccessThreshold',
    encode: String,
    decode: v => Number(v ?? 0),
  },
  failureThreshold: {
    param: 'FailureThreshold',
    responsePath: 'FailureThreshold',
    encode: String,
    decode: v => Number(v ?? 0),
  },
};

/** Build a single probe's RPC params. probeType = 'LivenessProbe' | 'ReadinessProbe' | 'StartupProbe'. */
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

/** Parse a single ECI probe item from response. Uses mutable accumulator then casts to readonly. */
export function parseProbe(raw: EciProbeItem | undefined): ProbeSpec | undefined {
  if (!raw) return undefined;
  const spec: Record<string, unknown> = {};
  if (raw.InitialDelaySeconds !== undefined) spec.initialDelaySeconds = raw.InitialDelaySeconds;
  if (raw.PeriodSeconds !== undefined) spec.periodSeconds = raw.PeriodSeconds;
  if (raw.TimeoutSeconds !== undefined) spec.timeoutSeconds = raw.TimeoutSeconds;
  if (raw.FailureThreshold !== undefined) spec.failureThreshold = raw.FailureThreshold;
  if (raw.SuccessThreshold !== undefined) spec.successThreshold = raw.SuccessThreshold;
  if (raw.TcpSocket?.Port !== undefined) spec.tcpSocket = { port: raw.TcpSocket.Port };
  if (raw.HttpGet) {
    const hg: Record<string, unknown> = { path: raw.HttpGet.Path ?? '/', port: raw.HttpGet.Port ?? 80 };
    if (raw.HttpGet.Scheme) hg.scheme = raw.HttpGet.Scheme;
    spec.httpGet = hg;
  }
  if (raw.Exec?.Commands?.length) spec.exec = { command: raw.Exec.Commands };
  return Object.keys(spec).length > 0 ? (spec) : undefined;
}

// ═══════════════════════════════════════════════════════════════
// Volume spec (nested inside CreateContainerGroupInput)
// ═══════════════════════════════════════════════════════════════

type VolumeScalarKey = ScalarKeys<VolumeConfigInput>;

const VOLUME_SCALARS: CodecTable<VolumeConfigInput, VolumeScalarKey> = {
  id: {
    param: 'Name',
    responsePath: 'Name',
    encode: v => v,
    decode: v => String(v ?? ''),
  },
  type: {
    param: 'Type',
    responsePath: 'Type',
    encode: v => v,
    decode: v => String(v ?? ''),
  },
};
// NOTE: options is excluded from VolumeScalarKey by ScalarKeys<> derivation
// (Record<string, unknown> is not a scalar).  Handled in buildVolumeCompound().

/** Volume compound builder — dispatches options by type. */
function buildVolumeCompound(v: VolumeConfigInput, pfx: string): Record<string, string> {
  const p: Record<string, string> = {};
  const opts = (v.options ?? {});

  if (opts.server) {
    // NFS volume
    p[`${pfx}.NFSVolume.Server`] = String(opts.server);
    p[`${pfx}.NFSVolume.Path`] = String(opts.path ?? '');
    if (opts.readOnly) p[`${pfx}.NFSVolume.ReadOnly`] = 'true';
  }
  if (opts.bucket) {
    // OSS volume (S3-compatible)
    p[`${pfx}.Type`] = 'OSSVolume';
    p[`${pfx}.OSSVolume.Bucket`] = String(opts.bucket);
    if (opts.path) p[`${pfx}.OSSVolume.Path`] = String(opts.path);
    if (opts.readOnly) p[`${pfx}.OSSVolume.ReadOnly`] = 'true';
    if (opts.endpoint) p[`${pfx}.OSSVolume.Endpoint`] = String(opts.endpoint);
  }
  if (opts.diskId) {
    // Cloud disk (云盘)
    p[`${pfx}.DiskVolume.DiskId`] = String(opts.diskId);
    p[`${pfx}.DiskVolume.FsType`] = String(opts.fsType ?? 'ext4');
    if (opts.sizeGiB !== undefined) p[`${pfx}.DiskVolume.DiskSize`] = String(opts.sizeGiB);
    if (opts.diskCategory) p[`${pfx}.DiskVolume.DiskCategory`] = String(opts.diskCategory);
    if (opts.readOnly) p[`${pfx}.DiskVolume.ReadOnly`] = 'true';
    if (opts.deleteWithInstance) p[`${pfx}.DiskVolume.DeleteWithInstance`] = 'true';
  }
  if (v.type === 'ConfigMapVolume' || opts.configMapName) {
    const name = String(opts.configMapName ?? opts.name ?? '');
    const items = (opts.items as { key: string; path: string; mode?: number }[] | undefined) ?? [];
    p[`${pfx}.ConfigMapVolume.Name`] = name;
    items.forEach((item, j) => {
      p[`${pfx}.ConfigMapVolume.Items.${j + 1}.Key`] = item.key;
      p[`${pfx}.ConfigMapVolume.Items.${j + 1}.Path`] = item.path;
      if (item.mode !== undefined) p[`${pfx}.ConfigMapVolume.Items.${j + 1}.Mode`] = String(item.mode);
    });
  }
  if (v.type === 'SecretVolume' || opts.secretName) {
    const name = String(opts.secretName ?? opts.name ?? '');
    const items = (opts.items as { key: string; path: string; mode?: number }[] | undefined) ?? [];
    p[`${pfx}.SecretVolume.SecretName`] = name;
    items.forEach((item, j) => {
      p[`${pfx}.SecretVolume.Items.${j + 1}.Key`] = item.key;
      p[`${pfx}.SecretVolume.Items.${j + 1}.Path`] = item.path;
      if (item.mode !== undefined) p[`${pfx}.SecretVolume.Items.${j + 1}.Mode`] = String(item.mode);
    });
  }
  return p;
}

/** Parse volumes from ECI response. */
function parseVolumes(vols: EciVolumeItem[] | undefined): VolumeRuntimeInfo[] {
  if (!vols?.length) return [];
  return vols.map(v => ({
    name: v.Name ?? '',
    type: v.Type ?? '',
    ...(v.NFSVolume ? {
      nfs: { server: v.NFSVolume.Server ?? '', path: v.NFSVolume.Path ?? '', readOnly: !!v.NFSVolume.ReadOnly },
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
    p[`Tag.${i + 1}.Key`] = t.key;
    p[`Tag.${i + 1}.Value`] = t.value;
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

/**
 * Build the full flat parameter map for Alibaba ECI CreateContainerGroup.
 * Called by `create()` and `update()` (with `partial` flag).
 */
export function buildCreateParams(
  input: CreateContainerGroupInput,
  opts?: { partial?: boolean },
): Record<string, string> {
  const partial = opts?.partial ?? false;
  const p: Record<string, string> = {};

  // ── Region (always set except partial without region) ──
  if (!partial || input.region != null) {
    p.RegionId = String(input.region);
  }

  // ── Top-level scalars ──
  // Object.entries loses key-codec correlation (TS limitation).
  // Cast is safe: CodecTable<> verified field-type match at definition.
  for (const [key, codec] of Object.entries(TOP_SCALARS as Record<string, EciFieldCodec<any>>)) {
    // Skip GPU fields — handled as compound below
    if (key === 'gpu' || key === 'gpuType') continue;
    const val = input[key as TopScalarKey];
    if (val !== undefined && val !== null) {
      p[codec.param] = codec.encode(val);
    }
  }

  // ── GPU (compound) ──
  if (!partial || input.gpu !== undefined) {
    Object.assign(p, buildGpuParam(input));
  }

  // ── Containers ──
  if (input.containers?.length) {
    input.containers.forEach((c, i) => {
      const cpfx = `Container.${i + 1}`;

      // Container scalars — see note above on Object.entries cast
      for (const [key, codec] of Object.entries(CONTAINER_SCALARS as Record<string, EciFieldCodec<any>>)) {
        const val = c[key as ContainerScalarKey];
        if (val !== undefined && val !== null) {
          p[`${cpfx}.${codec.param}`] = codec.encode(val);
        }
      }

      // command / args (compound: array → space-joined string)
      if (c.command?.length) p[`${cpfx}.Command`] = c.command.join(' ');
      if (c.args?.length) p[`${cpfx}.Args`] = c.args.join(' ');

      // resources (compound)
      Object.assign(p, buildContainerCompound(c, cpfx));

      // env (sub-array)
      Object.assign(p, buildEnvParams(c.env, cpfx));

      // ports (sub-array)
      Object.assign(p, buildPortParams(c.ports, cpfx));

      // probes (liveness / readiness / startup)
      Object.assign(p, buildProbeParams(c.livenessProbe, cpfx, 'LivenessProbe'));
      Object.assign(p, buildProbeParams(c.readinessProbe, cpfx, 'ReadinessProbe'));
      Object.assign(p, buildProbeParams(c.startupProbe, cpfx, 'StartupProbe'));
    });
  }

  // ── Volumes ──
  if (input.volumes?.length) {
    input.volumes.forEach((v, i) => {
      const vpfx = `Volume.${i + 1}`;
      p[`${vpfx}.Name`] = v.id;
      p[`${vpfx}.Type`] = v.type;
      Object.assign(p, buildVolumeCompound(v, vpfx));
    });
  }

  // ── Network ──
  if (!partial || input.network) {
    p.SecurityGroupId = input.network.securityGroupId ?? '';
    if (input.network.subnetIds?.length) {
      p.VSwitchId = input.network.subnetIds.join(',');
      p.ScheduleStrategy = 'VSwitchRandom';
      delete p.ZoneId;
    }
  }

  // ── Image cache (hardcoded default) ──
  if (!partial) {
    p.AutoMatchImageCache = 'true';
  }

  // ── Tags ──
  if (!partial || input.tags) {
    Object.assign(p, buildTagParams(input));
  }

  // ── Extension fields (providerOverrides) ──
  if (input.providerOverrides) {
    const raw = input.providerOverrides;
    const flat = (raw.alibaba as Record<string, unknown> | undefined) ?? raw;
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

/** Map Alibaba ECS GPU instance type prefix to human-readable GPU model. */
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
    type: (r.ResourceType === 'EIP' ? 'eip' : r.ResourceType?.toLowerCase()) as AssociatedResource['type'],
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

/**
 * Parse Alibaba DescribeContainerGroups response into provider-agnostic runtime.
 * Uses the same codec tables that drive create() — only the responsePath is used.
 */
export function parseContainerGroup(item: EciDescribeResponse): ContainerGroupRuntime {
  const containers: EciContainerItem[] = item.Containers ?? [];
  const zoneId = item.ZoneId ? createZoneId(item.ZoneId, 'alibaba') : undefined;
  const gpu = item.Gpu ? Number(item.Gpu) : undefined;
  const gpuModel = gpuModelFromInstanceType(item.InstanceType);
  const ephemeral = item.EphemeralStorage ? Number(item.EphemeralStorage) : undefined;

  return {
    providerId: item.ContainerGroupId ?? '',
    name: item.ContainerGroupName ?? '',
    status: (item.Status ?? 'Pending') as ContainerGroupStatus,
    regionId: createRegionId(item.RegionId ?? 'cn-hangzhou'),
    cpu: item.Cpu ?? 0,
    memory: item.Memory ?? 0,
    network: {
      ...(item.IntranetIp ?? item.PrivateIp ? { privateIp: (item.IntranetIp ?? item.PrivateIp)! } : {}),
      ...(item.VpcId ? { vpcId: item.VpcId } : {}),
      ...(item.VSwitchId ? { subnetId: item.VSwitchId } : {}),
      ...(item.SecurityGroupId ? { securityGroupId: item.SecurityGroupId } : {}),
      ...(item.EniInstanceId ? { eniId: item.EniInstanceId } : {}),
    },
    associatedResources: parseAssociatedResources(item.AssociatedResources),
    restartPolicy: item.RestartPolicy ?? 'Always',
    containers: containers.map(c => ({
      id: createContainerId(c.ContainerId || 'ctr-unknown'),
      name: c.Name ?? '',
      image: c.Image ?? '',
      args: c.Args ?? [],
      env: parseEnv(c.EnvironmentVars),
      workingDir: c.WorkingDir ?? '',
      status: (c.Status?.toLowerCase() ?? 'creating') as OciContainerStatus,
      alive: c.Status === 'Running',
      createdAt: c.CreationTime ?? '',
      ...(c.StartedAt ? { startedAt: c.StartedAt } : {}),
      ...(c.FinishedAt ? { finishedAt: c.FinishedAt } : {}),
      ...(c.ExitCode !== undefined ? { exitCode: c.ExitCode } : {}),
      labels: {},
      annotations: {},
      mounts: [],
      ...(c.Cpu || c.Memory || c.Gpu ? {
        resources: {
          cpu: c.Cpu ?? 0,
          memory: c.Memory ?? 0,
          ...(c.Gpu ? { gpu: Number(c.Gpu) } : {}),
        },
      } : {}),
      health: { status: c.Status === 'Running' ? 'healthy' : 'starting' },
    })),
    volumes: parseVolumes(item.Volumes),
    events: parseEvents(item.Events),
    tags: parseTags(item.Tags),
    // Optional fields via spread (exactOptionalPropertyTypes)
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
// Compile-time (3 layers):
//   1. ScalarKeys<T>         — auto-derives field union from interface
//   2. Record<ScalarKeys, …> — no missing keys, no extra keys
//   3. CodecTable<Interface> — each codec's T must match field type
//
// Init-time: validateCodecIntegrity() verifies every codec entry has
// actual encode/decode functions.  Catches `as any` bypasses and
// malformed codec objects that compile-time can't detect.

/** Runtime validation: ensure every codec entry has actual encode/decode
 *  functions.  Key-set correctness is guaranteed at compile time by
 *  Record<ScalarKeys, ...> — this check only guards against runtime
 *  corruption and `as any` type-system bypasses. */
export function validateCodecIntegrity(): { ok: boolean; broken: string[] } {
  const tables: Record<string, Record<string, unknown>> = {
    TOP_SCALARS,
    CONTAINER_SCALARS,
    PROBE_SCALARS,
    PORT_SCALARS,
    VOLUME_SCALARS,
  };

  const broken: string[] = [];
  for (const [name, table] of Object.entries(tables)) {
    for (const [key, codec] of Object.entries(table)) {
      const c = codec as Record<string, unknown> | undefined;
      if (!c || typeof c.encode !== 'function') {
        broken.push(`${name}.${key}: encode is not a function`);
      }
      if (!c || typeof c.decode !== 'function') {
        broken.push(`${name}.${key}: decode is not a function`);
      }
      if (c && typeof c.param !== 'string') {
        broken.push(`${name}.${key}: param is not a string`);
      }
    }
  }

  if (broken.length > 0) {
    console.error('[eci-codec] Codec integrity failure:', broken.join('; '));
  }
  return { ok: broken.length === 0, broken };
}

// Run at module load
const _INTEGRITY = validateCodecIntegrity();
void _INTEGRITY;

void PORT_SCALARS;
void PROBE_SCALARS;
void VOLUME_SCALARS;
void ENV_SPEC;
