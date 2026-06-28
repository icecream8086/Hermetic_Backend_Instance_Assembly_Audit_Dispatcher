import { z } from 'zod';
import type {
  BaseEntity,
  PersistedEntity,
  ValueObject,
  Tag,
} from './base.ts';
import type { EnvVar, ProbeSpec, ResourceRequirements } from '../../core/provider/types.ts';
import type { ContainerRestartPolicy } from '../../core/scheduler/backoff.ts';
import type { RegionId } from '../../core/region/types.ts';
import type { NetworkId } from '../../core/network/types.ts';
import type { InstanceId } from '../../core/region/instance.ts';

// ─── Brand types (CEA: Zod .brand(), no `as` assertions) ───

const sandboxIdSchema = z.string().min(1).brand('SandboxId');
const volumeIdSchema = z.string().min(1).brand('VolumeId');
const metricSnapshotIdSchema = z.string().min(1).brand('MetricSnapshotId');

export type SandboxId = z.infer<typeof sandboxIdSchema>;
export type VolumeId = z.infer<typeof volumeIdSchema>;
export type MetricSnapshotId = z.infer<typeof metricSnapshotIdSchema>;

export function createSandboxId(raw: string): SandboxId { return sandboxIdSchema.parse(raw); }
export function createVolumeId(raw: string): VolumeId { return volumeIdSchema.parse(raw); }
export function createMetricSnapshotId(raw: string): MetricSnapshotId { return metricSnapshotIdSchema.parse(raw); }

// ─── Sandbox state machine (ECI-aligned 11 states) ───

export enum SandboxStatus {
  /** Creating — being scheduled to underlying compute resources. */
  Scheduling = 'Scheduling',
  /** Scheduling failed — insufficient resources, invalid params, zone unavailable. */
  ScheduleFailed = 'ScheduleFailed',
  /** Starting — pulling images, initializing init/sidecar containers. */
  Pending = 'Pending',
  /** Running normally. */
  Running = 'Running',
  /** Soft terminal — containers exited successfully (exit 0). Can be restarted (GHA RerunRun analogy). */
  Succeeded = 'Succeeded',
  /** Soft terminal — containers failed. Can be restarted (GHA RerunFailedJobs analogy). */
  Failed = 'Failed',
  /** Being restarted via RestartContainerGroup. */
  Restarting = 'Restarting',
  /** Being updated via UpdateContainerGroup. */
  Updating = 'Updating',
  /** Being stopped/deleted via DeleteContainerGroup. */
  Terminating = 'Terminating',
  /** Expired — spot instance reclaimed or ActiveDeadlineSeconds exceeded. */
  Expired = 'Expired',
  /** Resource removed from the system. Terminal sink state. */
  Deleted = 'Deleted',
}

/**
 * Hard terminal states — truly irreversible.
 * GHA/K8s Job design: Succeeded and Failed are soft terminals (can be restarted,
 * analogous to GHA's RerunRun/RerunFailedJobs). Only infrastructure-level failures
 * (ScheduleFailed, Expired) and Deleted are hard terminals.
 */
export const TERMINAL_STATES: ReadonlySet<SandboxStatus> = new Set([
  SandboxStatus.ScheduleFailed,
  SandboxStatus.Expired,
  SandboxStatus.Deleted,
]);

/** States that can be deleted via DeleteContainerGroup.
 *  GHA/K8s Job design: Succeeded and Failed sandboxes can be deleted (cleanup). */
export const DELETABLE_STATES: ReadonlySet<SandboxStatus> = new Set([
  SandboxStatus.Running,
  SandboxStatus.Pending,
  SandboxStatus.Restarting,
  SandboxStatus.Updating,
  SandboxStatus.Succeeded,
  SandboxStatus.Failed,
]);

export const VALID_TRANSITIONS: Readonly<Record<SandboxStatus, readonly SandboxStatus[]>> = {
  // T1-T2: Scheduling outcomes — can also be deleted (ECI asyncInit: user cancels before Running)
  [SandboxStatus.Scheduling]: [SandboxStatus.Pending, SandboxStatus.ScheduleFailed, SandboxStatus.Terminating],
  // T3-T4, T18: Pending outcomes — delete goes through Terminating (async cleanup)
  [SandboxStatus.Pending]: [SandboxStatus.Running, SandboxStatus.Failed, SandboxStatus.Terminating],
  // T5-T10: Running outcomes — delete goes through Terminating (async cleanup)
  [SandboxStatus.Running]: [
    SandboxStatus.Succeeded, SandboxStatus.Failed, SandboxStatus.Expired,
    SandboxStatus.Restarting, SandboxStatus.Updating, SandboxStatus.Terminating,
  ],
  // T11-T12, T16: Restarting outcomes — delete goes through Terminating
  [SandboxStatus.Restarting]: [SandboxStatus.Pending, SandboxStatus.Failed, SandboxStatus.Terminating],
  // T13-T14, T17: Updating outcomes — delete goes through Terminating
  [SandboxStatus.Updating]: [SandboxStatus.Running, SandboxStatus.Terminating],
  // T15: Terminating outcome — cloud cleanup confirmed, resource released
  [SandboxStatus.Terminating]: [SandboxStatus.Deleted],
  // Hard terminal states (infrastructure) — no cloud resources, direct cleanup
  [SandboxStatus.ScheduleFailed]: [SandboxStatus.Deleted],
  [SandboxStatus.Expired]: [SandboxStatus.Deleted],
  [SandboxStatus.Deleted]: [],
  // Soft terminal states (GHA/K8s Job) — restartable, deletable via Terminating
  [SandboxStatus.Succeeded]: [SandboxStatus.Running, SandboxStatus.Terminating],
  [SandboxStatus.Failed]: [SandboxStatus.Running, SandboxStatus.Terminating],
};

export function isValidTransition(from: SandboxStatus, to: SandboxStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminal(status: SandboxStatus): boolean {
  return TERMINAL_STATES.has(status);
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
  /** ConfigMap — inject non-sensitive configuration data as files. */
  ConfigMap = 'ConfigMapVolume',
  /** OSS (Object Storage Service) — mount cloud object storage as a filesystem. */
  OSS = 'OSSVolume',
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

export interface ConfigMapVolumeConfig {
  /** ConfigMap name (provider-resolved). */
  readonly name: string;
  /** Specific items to project as files. Omit to project all keys. */
  readonly items?: readonly { readonly key: string; readonly path: string; readonly mode?: number }[];
}

export interface OSSVolumeConfig {
  /** OSS bucket name. */
  readonly bucket: string;
  /** Path within the bucket (prefix). */
  readonly path?: string | undefined;
  /** Whether the mount is read-only. */
  readonly readOnly?: boolean | undefined;
  /** Custom OSS endpoint for VPC access. */
  readonly endpoint?: string | undefined;
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
  readonly configMap?: ConfigMapVolumeConfig;
  readonly oss?: OSSVolumeConfig;
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
  /** Per-container restart rules (K8s v1.34 Alpha). Overwrites pod-level restartPolicy. */
  readonly containerRestartPolicy?: ContainerRestartPolicy;
  /** Network mode: 'bridge' | 'host' | 'none' | 'container:<name|id>'. */
  readonly networkMode?: string | undefined;
  readonly providerOverrides?: Record<string, unknown>;
}

/** Init containers — run to completion before main containers start. */
export interface InitContainerConfig extends ContainerConfig {
  readonly restartPolicy?: 'Always' | 'OnFailure' | 'Never';
}

/** Container-level status — mirrors K8s container states. */
export enum ContainerStatus {
  Waiting = 'Waiting',
  Running = 'Running',
  Terminated = 'Terminated',
}

export interface ContainerState {
  readonly state: ContainerStatus;
  readonly startTime?: string;
  readonly finishedTime?: string;
  readonly ready: boolean;
  readonly restartCount: number;
  readonly message?: string;
  /** Set when state=Terminated */
  readonly exitCode?: number;
  /** Set when state=Terminated — Completed | Error | OOMKilled | ... */
  readonly reason?: string;
  /** Set when state=Terminated — signal number if killed by signal */
  readonly signal?: number;
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
  /** Zone ID for provider scheduling (e.g. cn-hangzhou-a). Set by assembly pipeline. */
  readonly zoneId?: string | undefined;
  readonly resourceSpec: ResourceSpec;
  // spotStrategy moved to providerOverrides.alibaba — it's provider-specific.
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
  /** Template ID that created this sandbox. Used for instance limit tracking (decoupled from sandbox name). */
  readonly templateRef?: string | undefined;
  /** API version of the template that created this sandbox ("hbi-aad/v1" or "hbi-aad/v2"). */
  readonly apiVersion?: string | undefined;
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
  /** Ephemeral storage allocated by the cloud provider (GiB).
   *  ECI provides 30 GiB free. Populated from provider during syncRuntime. */
  readonly ephemeralStorageGiB?: number | undefined;
}

// ─── Pod ↔ Sandbox ↔ Provider mapping ───

export interface PodMapping {
  readonly podUid: string;
  readonly sandboxId: SandboxId;
  readonly providerId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}


