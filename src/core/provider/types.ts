// ─── Container Group Resource Instance ───
// Represents the real-time state of a container group resource from any cloud provider.
// Derived from Alibaba ECI DescribeContainerGroups response structure (see catch/script0/).
//
// Design invariants:
// - Provider-agnostic — no Alibaba/AWS/GCP types leak through.
// - All fields map to fields from the cloud provider's "describe" API.
// - This lives in core/ so both providers/ and features/ can reference it.

/** Real-time status from the cloud provider. */
export type ContainerGroupStatus =
  | 'Pending'
  | 'Scheduling'
  | 'Running'
  | 'Succeeded'
  | 'Failed'
  | 'Expiring'
  | 'Expired'
  | 'Restarting';

export interface ContainerRuntimeInfo {
  readonly name: string;
  readonly image: string;
  readonly args: readonly string[];
  readonly cpu: number;
  readonly memory: number;
  readonly ready: boolean;
  readonly restartCount: number;
  readonly state: {
    readonly state: 'Running' | 'Waiting' | 'Terminated';
    readonly startTime?: string;
  };
  readonly volumeMounts: readonly {
    readonly name: string;
    readonly mountPath: string;
    readonly readOnly: boolean;
    readonly mountPropagation?: string;
  }[];
}

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
  readonly vswitchId?: string;
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

/** A container group resource instance as reported by the cloud provider. */
export interface ContainerGroupRuntime {
  readonly providerId: string;
  readonly name: string;
  readonly status: ContainerGroupStatus;
  readonly regionId: string;
  readonly zoneId?: string;
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
  readonly containers: readonly ContainerRuntimeInfo[];
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
