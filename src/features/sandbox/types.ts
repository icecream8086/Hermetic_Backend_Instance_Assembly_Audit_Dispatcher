import type {
  BaseEntity,
  PersistedEntity,
  ValueObject,
  Tag,
} from './base.ts';
import type { EnvVar, ProbeSpec, ResourceRequirements } from '../../core/provider/types.ts';

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
  [SandboxStatus.Scheduling]: [SandboxStatus.Running, SandboxStatus.Failed],
  [SandboxStatus.Running]: [SandboxStatus.Stopped, SandboxStatus.Terminated, SandboxStatus.Deleted],
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
  readonly env?: readonly EnvVar[];
  readonly tty?: boolean;
  readonly stdin?: boolean;
  readonly imagePullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
  readonly resources?: ResourceRequirements;
  readonly volumeMounts?: readonly VolumeMount[];
  readonly livenessProbe?: ProbeSpec;
  readonly readinessProbe?: ProbeSpec;
  readonly startupProbe?: ProbeSpec;
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

export interface SandboxNetworkConfig {
  readonly subnetIds?: readonly string[];
  readonly securityGroupId?: string;
  readonly allocatePublicIp: boolean;
  readonly publicIpBandwidth?: number;
}

// ─── Sandbox ───

export interface CreateSandboxInput {
  readonly name: string;
  readonly description?: string;
  readonly region: string;
  readonly resourceSpec: ResourceSpec;
  readonly spotStrategy: SpotStrategy;
  readonly restartPolicy: 'Always' | 'OnFailure' | 'Never';
  readonly initContainers?: readonly InitContainerConfig[];
  readonly containers: readonly ContainerConfig[];
  readonly volumes?: readonly Volume[];
  readonly network: SandboxNetworkConfig;
  readonly tags?: readonly Tag[];
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


