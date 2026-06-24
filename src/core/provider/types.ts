// ─── Container Group Resource Instance ───
// Represents the real-time state of a container group resource from any cloud provider.
// Derived from Alibaba ECI DescribeContainerGroups response structure (see catch/script0/).
//
// Design invariants:
// - Provider-agnostic — no Alibaba/AWS/GCP types leak through.
// - All fields map to fields from the cloud provider's "describe" API.
// - This lives in core/ so both providers/ and features/ can reference it.
//
// OCI container types live here because cloud provider instances ARE
// OCI Runtime containers (same object, different abstraction layers).

/** Real-time status from the cloud provider. */
export type ContainerGroupStatus =
  | 'Pending'
  | 'Scheduling'
  | 'ScheduleFailed'
  | 'Running'
  | 'Succeeded'
  | 'Failed'
  | 'Expiring'
  | 'Expired'
  | 'Restarting';

// ─── OCI Container types (core) ───

import type { RegionId, ZoneId } from '../region/types.ts';
import type { InstanceId } from '../region/instance.ts';

declare const CONTAINER_ID_BRAND: unique symbol;
export type ContainerId = string & { readonly [CONTAINER_ID_BRAND]: true };

export function createContainerId(raw: string): ContainerId {
  if (!raw) throw new TypeError('ContainerId must not be empty');
  return raw as ContainerId;
}

/** Standard OCI container states — used by both cloud provider and OCI Runtime. */
export type OciContainerStatus =
  | 'creating'
  | 'created'
  | 'running'
  | 'stopped'
  | 'paused'
  | 'error'
  | 'deleted';

export type OciHealthStatus = 'none' | 'starting' | 'healthy' | 'unhealthy';

export type OciImageRef = string;

/** A container as managed by the OCI Runtime.
 *  Cloud orchestration creates instances → these are the same objects
 *  that the OCI Runtime manages at the OS level. */
export interface OciContainer {
  readonly id: ContainerId;
  readonly name: string;
  readonly image: OciImageRef;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly workingDir: string;
  readonly status: OciContainerStatus;
  /** Is the container's main process currently alive? */
  readonly alive: boolean;
  readonly createdAt: string;
  readonly startedAt?: string | undefined;
  readonly finishedAt?: string | undefined;
  readonly exitCode?: number | undefined;
  readonly labels: Record<string, string>;
  readonly annotations: Record<string, string>;
  readonly mounts: readonly {
    readonly source: string;
    readonly destination: string;
    readonly type?: string | undefined;
    readonly options?: readonly string[] | undefined;
  }[];
  readonly network?: {
    readonly ipAddress: string;
    readonly gateway: string;
    readonly ports: readonly {
      readonly containerPort: number;
      readonly hostPort?: number | undefined;
      readonly protocol: 'tcp' | 'udp';
    }[];
  } | undefined;
  /** Allocated resources for this container. */
  readonly resources?: {
    readonly cpu: number;
    readonly memory: number;
    readonly cpuUsagePercent?: number;
    readonly memoryUsageBytes?: number;
    readonly memoryLimitBytes?: number;
    readonly pidsCurrent?: number;
  } | undefined;
  readonly health: {
    readonly status: OciHealthStatus;
    readonly lastCheckedAt?: string;
    readonly message?: string;
    readonly failingSince?: string;
  };
}

// ─── Cloud resource types ───

export interface VolumeRuntimeInfo {
  readonly name: string;
  readonly type: string;
  readonly nfs?: {
    readonly server: string;
    readonly path: string;
    readonly readOnly: boolean;
  };
}

export interface ContainerGroupRuntimeEvent {
  readonly reason: string;
  readonly type: 'Normal' | 'Warning';
  readonly message: string;
  readonly count: number;
  readonly lastTimestamp?: string;
}

/** Private network interface — the container group's ENI within a VPC.
 *  Public IP (EIP) is a separate associated resource, not part of this. */
export interface ContainerGroupNetwork {
  readonly privateIp?: string;
  readonly vpcId?: string;
  readonly subnetId?: string;
  readonly securityGroupId?: string;
  readonly eniId?: string;
}

/** Known types of cloud resources that can be attached to a container group. */
export type AssociatedResourceType = 'eip';

/** A cloud resource attached to the container group with its own identity and lifecycle.
 *  EIP (Elastic IP) is the most common example — created separately from the container group
 *  and associated to the ENI for public access. */
export interface AssociatedResource {
  readonly type: AssociatedResourceType;
  readonly resourceId: string;
  readonly ip?: string;
  readonly bandwidth?: number;
  readonly isp?: string;
  readonly status?: string;
}

// ─── Virtual Node types ───

/** Capacity/resources a virtual node reports to the cluster. */
export interface NodeCapacity {
  readonly cpu: number;
  readonly memory: number;          // MB
  readonly podCount: number;
  readonly gpu?: number;
  readonly gpuType?: string;
  readonly ephemeralStorage?: number; // GB
}

export interface NodeCondition {
  readonly type: 'Ready' | 'MemoryPressure' | 'DiskPressure' | 'PIDPressure' | 'NetworkUnavailable';
  readonly status: 'True' | 'False' | 'Unknown';
  readonly lastHeartbeatTime?: string;
  readonly lastTransitionTime?: string;
  readonly reason?: string;
  readonly message?: string;
}

// ─── EnvVar with ValueFrom support ───

export interface EnvVar {
  readonly name: string;
  readonly value?: string | undefined;
  readonly valueFrom?: {
    readonly secretKeyRef?: { readonly name: string; readonly key: string };
    readonly configMapKeyRef?: { readonly name: string; readonly key: string };
    readonly fieldRef?: { readonly fieldPath: string };
  } | undefined;
}

// ─── Resource requirements (requests vs limits) ───

export interface ResourceRequirements {
  readonly requests?: { readonly cpu: number; readonly memory: number; readonly gpu?: number } | undefined;
  readonly limits?: { readonly cpu: number; readonly memory: number; readonly gpu?: number; readonly gpuType?: string } | undefined;
}

// ─── Probe ───

export interface ProbeSpec {
  readonly initialDelaySeconds?: number | undefined;
  readonly timeoutSeconds?: number | undefined;
  readonly periodSeconds?: number | undefined;
  readonly successThreshold?: number | undefined;
  readonly failureThreshold?: number | undefined;
  readonly httpGet?: { readonly path: string; readonly port: number; readonly scheme?: string } | undefined;
  readonly exec?: { readonly command: readonly string[] } | undefined;
  readonly tcpSocket?: { readonly port: number } | undefined;
}

/** A container group resource instance as reported by the cloud provider.
 *  Each container in the group IS an OciContainer — the cloud orchestrator
 *  creates them, the OCI Runtime manages them at the OS level. */
export interface ContainerGroupRuntime {
  readonly providerId: string;
  readonly name: string;
  readonly status: ContainerGroupStatus;
  readonly regionId: RegionId;
  readonly zoneId?: ZoneId | undefined;
  readonly instanceId?: InstanceId | undefined;
  readonly creationTime?: string;
  readonly expiredTime?: string;
  readonly instanceType?: string;
  readonly spotStrategy?: string;
  readonly cpu: number;
  readonly memory: number;
  readonly discount?: number;
  /** Private VPC network of the container group's ENI. */
  readonly network: ContainerGroupNetwork;
  /** Cloud resources attached to this group (EIP, etc.). Each has its own lifecycle. */
  readonly associatedResources: readonly AssociatedResource[];
  readonly restartPolicy: string;
  /** Containers in this group. These ARE OCI Runtime containers. */
  readonly containers: readonly OciContainer[];
  readonly volumes: readonly VolumeRuntimeInfo[];
  readonly events: readonly ContainerGroupRuntimeEvent[];
  readonly tags: readonly { key: string; value: string }[];
}

// ─── MetricSnapshot (moved from features/sandbox/types.ts to fix dep direction) ───

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

/** A time-series metrics data point. identity = sandboxId + timestamp. */
export interface MetricSnapshot {
  readonly id: string;
  readonly sandboxId: string;
  readonly timestamp: number;
  readonly cpu: CPUMetrics;
  readonly memory: MemoryMetrics;
  readonly network: NetworkMetrics;
  readonly disk: DiskMetrics;
  readonly containers: readonly ContainerMetrics[];
}

// ─── Container Group Creation Input (provider boundary) ───
// Provider-agnostic input for IContainerProvider.create().
// No sandbox domain types — the business layer maps to this type.

export interface ContainerPortConfig {
  readonly containerPort: number;
  readonly hostPort?: number | undefined;
  readonly protocol?: string | undefined;
}

export interface ContainerCreateConfig {
  readonly name: string;
  readonly image: string;
  readonly command?: readonly string[] | undefined;
  readonly args?: readonly string[] | undefined;
  readonly env?: readonly EnvVar[] | undefined;
  readonly tty?: boolean | undefined;
  readonly stdin?: boolean | undefined;
  readonly imagePullPolicy?: string | undefined;
  readonly resources?: ResourceRequirements | undefined;
  readonly livenessProbe?: ProbeSpec | undefined;
  readonly readinessProbe?: ProbeSpec | undefined;
  readonly startupProbe?: ProbeSpec | undefined;
  readonly ports?: readonly ContainerPortConfig[] | undefined;
  readonly volumeMounts?: readonly VolumeMountConfig[] | undefined;
  /** Network mode: 'bridge' | 'host' | 'none' | 'container:<name|id>'. */
  readonly networkMode?: string | undefined;
  readonly providerOverrides?: Record<string, unknown> | undefined;
}

export interface SecretMountConfig {
  readonly mountPath: string;
  /** Resolved plaintext content. */
  readonly data: string;
  readonly mode?: number | undefined;
}

export interface VolumeMountConfig {
  readonly volumeId: string;
  readonly mountPath: string;
  readonly readOnly: boolean;
  readonly mountPropagation?: string | undefined;
  /** Credential reference for external auth, resolved at provider level. */
  readonly credentialRef?: string | undefined;
}

export interface VolumeConfigInput {
  readonly id: string;
  readonly type: string;
  /** Provider-specific volume options (e.g. NFS {server, path, readOnly}). */
  readonly options?: Record<string, unknown> | undefined;
}

export interface ContainerGroupNetworkInput {
  readonly subnetIds?: readonly string[] | undefined;
  readonly securityGroupId?: string | undefined;
  readonly allocatePublicIp: boolean;
  readonly publicIpBandwidth?: number | undefined;
  /** 带宽控制（Mbps），从 SecurityGroup 自动继承 */
  readonly bandwidth?: {
    readonly egress?: number | undefined;
    readonly ingress?: number | undefined;
    readonly burst?: number | undefined;
    readonly priority?: number | undefined;
  } | undefined;
}

export interface CreateContainerGroupInput {
  readonly name: string;
  readonly description?: string | undefined;
  readonly region: RegionId;
  readonly instanceId?: InstanceId | undefined;
  readonly zoneId?: string | undefined;
  readonly cpu: number;
  readonly memory: number;
  readonly gpu?: number | undefined;
  readonly gpuType?: string | undefined;
  readonly spotStrategy: string;
  readonly restartPolicy: string;
  readonly containers: readonly ContainerCreateConfig[];
  readonly volumes?: readonly VolumeConfigInput[] | undefined;
  readonly secretMounts?: readonly SecretMountConfig[] | undefined;
  readonly network: ContainerGroupNetworkInput;
  readonly tags?: readonly { key: string; value: string }[] | undefined;
  readonly providerOverrides?: Record<string, unknown> | undefined;
}
