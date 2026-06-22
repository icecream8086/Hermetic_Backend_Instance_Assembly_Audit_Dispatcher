import type {
  BaseEntity,
  PersistedEntity,
  ValueObject,
  Tag,
} from './base.ts';
import type { EnvVar, ProbeSpec, ResourceRequirements } from '../../core/provider/types.ts';
import type { RegionId } from '../../core/region/types.ts';
import type { NetworkId } from '../../core/network/types.ts';
import type { InstanceId } from '../../core/region/instance.ts';

// ─── Brand types ───
declare const SANDBOX_ID_BRAND: unique symbol;
declare const VOLUME_ID_BRAND: unique symbol;
declare const METRIC_SNAPSHOT_ID_BRAND: unique symbol;

export type SandboxId = string & { readonly [SANDBOX_ID_BRAND]: true };
export type VolumeId = string & { readonly [VOLUME_ID_BRAND]: true };
export type MetricSnapshotId = string & { readonly [METRIC_SNAPSHOT_ID_BRAND]: true };

export function createSandboxId(raw: string): SandboxId { if (!raw) throw new TypeError('SandboxId must not be empty'); return raw as SandboxId; }
export function createVolumeId(raw: string): VolumeId { if (!raw) throw new TypeError('VolumeId must not be empty'); return raw as VolumeId; }
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
  [SandboxStatus.Pending]: [SandboxStatus.Scheduling, SandboxStatus.Running, SandboxStatus.Failed, SandboxStatus.Deleted],
  [SandboxStatus.Scheduling]: [SandboxStatus.Running, SandboxStatus.Stopped, SandboxStatus.Failed, SandboxStatus.Deleted],
  [SandboxStatus.Running]: [SandboxStatus.Stopped, SandboxStatus.Failed, SandboxStatus.Terminated, SandboxStatus.Deleted],
  [SandboxStatus.Stopped]: [SandboxStatus.Running, SandboxStatus.Terminated, SandboxStatus.Deleted],
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
  /** Cloud disk (阿里云 Disk / 云盘) — persistent block storage, single-instance attach. */
  Disk = 'DiskVolume',
  /** Secret — inject sensitive data (e.g. passwords, tokens) as in-memory files via provider (podman secret / KMS). */
  Secret = 'SecretVolume',
}

export interface NFSVolumeConfig {
  readonly server: string;
  readonly path: string;
  readonly readOnly: boolean;
}

export interface DiskVolumeConfig {
  /** Cloud disk ID (e.g. Alibaba Cloud disk ID: d-xxxxxxxx). */
  readonly diskId: string;
  /** Filesystem type: 'ext4' | 'xfs'. */
  readonly fsType: string;
  /** Disk size in GiB (for auto-provision). */
  readonly sizeGiB?: number;
  /** Cloud disk category: cloud_efficiency | cloud_ssd | cloud_essd. */
  readonly diskCategory?: string | undefined;
  /** Whether the disk is read-only. */
  readonly readOnly: boolean;
  /** Whether to delete the disk when the instance is released. */
  readonly deleteWithInstance?: boolean;
}

export interface SecretVolumeConfig {
  /** Secret name (provider-resolved). */
  readonly name: string;
  /** Specific items to project as files. Omit to project all keys. */
  readonly items?: readonly { readonly key: string; readonly path: string; readonly mode?: number }[];
}

/** Volume entity — bound to a ComputeInstance (spatial locality). */
export interface Volume extends BaseEntity<VolumeId, VolumeStatus> {
  readonly type: VolumeType;
  /** The compute instance this volume is bound to. Required — volumes do not exist outside an instance. */
  readonly instanceId: string;
  /** Reference a named Credential (from CredentialService) for external auth — NFS Kerberos, OSS AK/SK, etc. */
  readonly credentialRef?: string;
  readonly nfs?: NFSVolumeConfig;
  readonly disk?: DiskVolumeConfig;
  readonly secret?: SecretVolumeConfig;
}

// ─── VolumeMount ───

export interface VolumeMount {
  readonly volumeId: VolumeId;
  readonly mountPath: string;
  readonly readOnly: boolean;
  readonly mountPropagation?: string;
  /** Named credential reference for external auth (e.g. NFS Kerberos, OSS AK/SK). */
  readonly credentialRef?: string | undefined;
}

// ─── Container ───

export interface ContainerConfig {
  readonly name: string;
  readonly image: string;
  readonly command?: readonly string[];
  readonly args?: readonly string[];
  readonly env?: readonly EnvVar[];
  readonly tty?: boolean;
  readonly stdin?: boolean;
  readonly imagePullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
  readonly resources?: ResourceRequirements;
  readonly volumeMounts?: readonly VolumeMount[];
  readonly ports?: readonly {
    readonly containerPort: number;
    readonly hostPort?: number | undefined;
    readonly protocol?: string | undefined;
  }[] | undefined;
  readonly livenessProbe?: ProbeSpec | undefined;
  readonly readinessProbe?: ProbeSpec | undefined;
  readonly startupProbe?: ProbeSpec | undefined;
  /** Network mode: 'bridge' | 'host' | 'none' | 'container:<name|id>'. */
  readonly networkMode?: string | undefined;
  readonly providerOverrides?: Record<string, unknown>;
}

/** Init containers — run to completion before main containers start. */
export interface InitContainerConfig extends ContainerConfig {
  readonly restartPolicy?: 'Always' | 'OnFailure' | 'Never';
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
  readonly health?: {
    readonly status: string;
    readonly lastCheckedAt?: string | undefined;
    readonly message?: string | undefined;
  } | undefined;
}

// ─── Network ───

export interface NetworkInfo {
  readonly publicIp?: string;
  readonly privateIp?: string;
  readonly ipAddress?: string;   // 用户指定的固定 IP（来自 subnet）
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
  readonly gpu?: number | undefined;
  readonly gpuType?: string | undefined;
  readonly requests?: ResourceRequirements['requests'] | undefined;
  readonly limits?: ResourceRequirements['limits'] | undefined;
}

// ─── Pod condition ───

export type ConditionStatus = 'True' | 'False' | 'Unknown';

export interface PodCondition {
  readonly type: 'PodScheduled' | 'Initialized' | 'ContainersReady' | 'Ready';
  readonly status: ConditionStatus;
  readonly lastTransitionTime?: string;
  readonly reason?: string;
  readonly message?: string;
}

// ─── Network config (input) ───

export interface ProviderIdentity {
  /** Provider platform: 'podman' | 'alibaba' | 'aws' | 'stub' */
  readonly platform: string;
  /** ComputeInstance ID used for credential resolution */
  readonly instanceId?: string;
  /** Instance region (for ECI/OSS API calls) */
  readonly region?: string;
  /** Instance zone (for multi-AZ) */
  readonly zoneId?: string;
  /** Credential reference used at creation time */
  readonly credentialRef?: string;
}

export interface SandboxNetworkConfig {
  /** 引用 VirtualNetwork，继承其安全组和规则 */
  readonly networkId?: NetworkId | undefined;
  /** 引用 ComputeCluster，继承其 zone/networkDomain */
  readonly instanceId?: InstanceId | undefined;
  readonly subnetIds?: readonly string[] | undefined;
  readonly ipAddress?: string | undefined;   // 手动指定固定 IP（不设则由系统自动分配）
  readonly securityGroupId?: string | undefined;
  readonly allocatePublicIp: boolean;
  readonly publicIpBandwidth?: number | undefined;
  /** 带宽控制（Mbps），由系统自动从 SecurityGroup 继承 */
  readonly bandwidth?: {
    readonly egress?: number | undefined;
    readonly ingress?: number | undefined;
    readonly burst?: number | undefined;
    readonly priority?: number | undefined;
  } | undefined;
}

// ─── Sandbox ───

export interface CreateSandboxInput {
  readonly name: string;
  readonly description?: string;
  readonly region: RegionId;
  readonly instanceId?: InstanceId | undefined;
  readonly resourceSpec: ResourceSpec;
  readonly spotStrategy: SpotStrategy;
  readonly restartPolicy: 'Always' | 'OnFailure' | 'Never';
  readonly initContainers?: readonly InitContainerConfig[];
  readonly containers: readonly ContainerConfig[];
  readonly volumes?: readonly Volume[];
  /** S3 存储桶挂载引用。由 template applicator 填充，用于自动生成访问密钥等。 */
  readonly bucketMounts?: readonly {
    readonly bucketId: string;
    readonly bucket: string;
    readonly endpoint: string;
    readonly region: string;
    readonly autoGenerateKeys?: boolean | undefined;
    readonly mountPath: string;
  }[];
  readonly network: SandboxNetworkConfig;
  readonly tags?: readonly Tag[];
  readonly account?: string | undefined;
  /** Max consecutive health check failures before auto-terminate. -1 = never terminate. */
  readonly healthMaxRetries?: number | undefined;
  /** User who created this sandbox. */
  readonly creatorId?: string | undefined;
  readonly providerOverrides?: Record<string, unknown>;
}

/** Full sandbox entity. Extends PersistedEntity for optimistic-concurrency state mutations. */
export interface Sandbox extends PersistedEntity<SandboxId, SandboxStatus> {
  readonly config: CreateSandboxInput;
  readonly podUid?: string;        // Kubernetes Pod UID
  readonly providerId?: string;    // Cloud provider instance ID
  readonly network: NetworkInfo;
  readonly containers: readonly ContainerRuntime[];
  readonly conditions?: readonly PodCondition[];
  readonly events: readonly ContainerEvent[];
}

// ─── Pod ↔ Sandbox ↔ Provider mapping ───

export interface PodMapping {
  readonly podUid: string;
  readonly sandboxId: SandboxId;
  readonly providerId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}


