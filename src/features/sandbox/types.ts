import type {
  Identifiable,
  BaseEntity,
  PersistedEntity,
  ValueObject,
  Tag,
} from './base.ts';

// ─── Brand types ───
declare const SANDBOX_ID_BRAND: unique symbol;
declare const VOLUME_ID_BRAND: unique symbol;
declare const DNS_RECORD_ID_BRAND: unique symbol;
declare const METRIC_SNAPSHOT_ID_BRAND: unique symbol;

export type SandboxId = string & { readonly [SANDBOX_ID_BRAND]: true };
export type VolumeId = string & { readonly [VOLUME_ID_BRAND]: true };
export type DnsRecordId = string & { readonly [DNS_RECORD_ID_BRAND]: true };
export type MetricSnapshotId = string & { readonly [METRIC_SNAPSHOT_ID_BRAND]: true };

export function createSandboxId(raw: string): SandboxId { if (!raw) throw new TypeError('SandboxId must not be empty'); return raw as SandboxId; }
export function createVolumeId(raw: string): VolumeId { if (!raw) throw new TypeError('VolumeId must not be empty'); return raw as VolumeId; }
export function createDnsRecordId(raw: string): DnsRecordId { if (!raw) throw new TypeError('DnsRecordId must not be empty'); return raw as DnsRecordId; }
export function createMetricSnapshotId(raw: string): MetricSnapshotId { if (!raw) throw new TypeError('MetricSnapshotId must not be empty'); return raw as MetricSnapshotId; }

// ─── Sandbox state machine ───

export enum SandboxStatus {
  Pending = 'Pending',
  Scheduling = 'Scheduling',
  Running = 'Running',
  Stopped = 'Stopped',
  Terminated = 'Terminated',
  Failed = 'Failed',
  Deleted = 'Deleted',
}

export const VALID_TRANSITIONS: Readonly<Record<SandboxStatus, readonly SandboxStatus[]>> = {
  [SandboxStatus.Pending]: [SandboxStatus.Scheduling, SandboxStatus.Running, SandboxStatus.Failed],
  [SandboxStatus.Scheduling]: [SandboxStatus.Running, SandboxStatus.Failed],
  [SandboxStatus.Running]: [SandboxStatus.Stopped, SandboxStatus.Terminated, SandboxStatus.Deleted],
  [SandboxStatus.Stopped]: [SandboxStatus.Running, SandboxStatus.Deleted],
  [SandboxStatus.Terminated]: [SandboxStatus.Deleted],
  [SandboxStatus.Failed]: [SandboxStatus.Deleted],
  [SandboxStatus.Deleted]: [],
};

export function isValidTransition(from: SandboxStatus, to: SandboxStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ─── Volume state machine ───

export enum VolumeStatus {
  Detached = 'Detached',
  Attached = 'Attached',
  Orphaned = 'Orphaned',
}

// ─── Volume ───

export enum VolumeType {
  NFS = 'NFSVolume',
  HostPath = 'HostPathVolume',
  EmptyDir = 'EmptyDirVolume',
}

export interface NFSVolumeConfig {
  readonly server: string;
  readonly path: string;
  readonly readOnly: boolean;
}

/** Volume entity — independent of any single Sandbox. */
export interface Volume extends BaseEntity<VolumeId, VolumeStatus> {
  readonly type: VolumeType;
  readonly nfs?: NFSVolumeConfig;
}

// ─── VolumeMount ───

export interface VolumeMount {
  readonly volumeId: VolumeId;
  readonly mountPath: string;
  readonly readOnly: boolean;
  readonly mountPropagation?: string;
}

// ─── Container ───

export interface ContainerConfig {
  readonly name: string;
  readonly image: string;
  readonly args?: readonly string[];
  readonly tty?: boolean;
  readonly stdin?: boolean;
  readonly imagePullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
  readonly volumeMounts?: readonly VolumeMount[];
  readonly providerOverrides?: Record<string, unknown>;
}

export interface ContainerState {
  readonly state: 'Running' | 'Waiting' | 'Terminated';
  readonly startTime?: string;
  readonly ready: boolean;
  readonly restartCount: number;
  readonly message?: string;
}

export interface ContainerRuntime {
  readonly name: string;
  readonly image: string;
  readonly cpu: number;
  readonly memory: number;
  readonly state: ContainerState;
  readonly volumeMounts: readonly VolumeMount[];
}

// ─── Network ───

export interface NetworkInfo {
  readonly publicIp?: string;
  readonly privateIp?: string;
  readonly vpcId?: string;
  readonly subnetId?: string;
  readonly securityGroupId?: string;
  readonly eniId?: string;
}

// ─── Event (value object) ───

export interface ContainerEvent extends ValueObject {
  readonly reason: string;
  readonly type: 'Normal' | 'Warning';
  readonly message: string;
  readonly count: number;
  readonly lastTimestamp?: string;
}

// ─── Spot / preemptible ───

export enum SpotStrategy {
  None = 'None',
  SpotAsPriceGo = 'SpotAsPriceGo',
  SpotWithPriceLimit = 'SpotWithPriceLimit',
}

// ─── Resource spec ───

export interface ResourceSpec {
  readonly cpu: number;
  readonly memory: number;
}

// ─── Sandbox ───

export interface CreateSandboxInput {
  readonly name: string;
  readonly description?: string;
  readonly region: string;
  readonly resourceSpec: ResourceSpec;
  readonly spotStrategy: SpotStrategy;
  readonly restartPolicy: 'Always' | 'OnFailure' | 'Never';
  readonly containers: readonly ContainerConfig[];
  readonly volumes?: readonly Volume[];
  readonly network: {
    readonly subnetIds?: readonly string[];
    readonly securityGroupId?: string;
    readonly allocatePublicIp: boolean;
    readonly publicIpBandwidth?: number;
  };
  readonly tags?: readonly Tag[];
  readonly providerOverrides?: Record<string, unknown>;
}

/** Full sandbox entity. Extends PersistedEntity for optimistic-concurrency state mutations. */
export interface Sandbox extends PersistedEntity<SandboxId, SandboxStatus> {
  readonly config: CreateSandboxInput;
  readonly providerId?: string;
  readonly network: NetworkInfo;
  readonly containers: readonly ContainerRuntime[];
  readonly events: readonly ContainerEvent[];
}

// ─── DNS ───

export enum DnsRecordStatus {
  Active = 'Active',
  Stale = 'Stale',
}

export interface DnsRecord extends BaseEntity<DnsRecordId, DnsRecordStatus> {
  readonly domain: string;
  readonly type: 'A' | 'CNAME';
  readonly value: string;
  readonly ttl: number;
  readonly proxied: boolean;
  readonly sandboxId: SandboxId;
}

// ─── MetricSnapshot (time-series data point, not an entity) ───

export interface CPUMetrics {
  readonly usageNanoCores: number;
  readonly usageCores: number;
}

export interface MemoryMetrics {
  readonly usageBytes: number;
  readonly rss: number;
  readonly cache: number;
}

export interface NetworkMetrics {
  readonly txBytes: number;
  readonly rxBytes: number;
  readonly txPackets: number;
  readonly rxPackets: number;
}

export interface DiskMetrics {
  readonly readBytes: number;
  readonly writeBytes: number;
  readonly readIo: number;
  readonly writeIo: number;
}

export interface ContainerMetrics {
  readonly containerName: string;
  readonly cpu: CPUMetrics;
  readonly memory: MemoryMetrics;
}

export interface MetricSnapshot extends Identifiable<MetricSnapshotId> {
  readonly sandboxId: SandboxId;
  readonly timestamp: number;
  readonly cpu: CPUMetrics;
  readonly memory: MemoryMetrics;
  readonly network: NetworkMetrics;
  readonly disk: DiskMetrics;
  readonly containers: readonly ContainerMetrics[];
}
