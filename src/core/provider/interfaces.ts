// ─── Provider abstraction layer ───
// Every cloud operation goes through these interfaces.
// Concrete implementations (Alibaba, AWS, GCP, Azure) live under src/providers/.
//
// Design invariants:
// - All input/output types are provider-agnostic — no Alibaba/AWS types leak through.
// - Each provider method maps 1:1 to a remote API call from script0.
// - Provider-specific config lives in an opaque `providerConfig` bag per sandbox,
//   so the business layer never branches on provider identity.

import type {
  ContainerGroupRuntime,
  ContainerGroupStatus,
  CreateContainerGroupInput,
  MetricSnapshot,
  NodeCapacity,
  NodeCondition,
} from './types.ts';

// ─── Container operations ───

export interface DescribeContainerGroupsInput {
  readonly region: string;
  readonly sandboxName?: string;
  readonly sandboxId?: string;
  readonly status?: ContainerGroupStatus;
  readonly limit?: number;
  readonly nextToken?: string;
}

export interface DescribeContainerGroupsResult {
  readonly sandboxes: readonly ContainerGroupRuntime[];
  readonly nextToken?: string;
  readonly totalCount?: number;
}

export interface DeleteContainerGroupInput {
  readonly region: string;
  readonly providerId: string;
}

export interface GetContainerLogInput {
  readonly region: string;
  readonly providerId: string;
  readonly containerName: string;
  readonly limitBytes?: number;
  readonly sinceSeconds?: number;
  readonly timestamps?: boolean;
}

export interface ContainerLogResult {
  readonly containerName: string;
  readonly content: string;
  readonly timestamp?: string;
}

export interface IContainerProvider {
  /** Create a container group. Returns the provider-assigned ID. */
  create(input: CreateContainerGroupInput): Promise<{ providerId: string }>;

  /** Query sandboxes by filters. */
  describe(input: DescribeContainerGroupsInput): Promise<DescribeContainerGroupsResult>;

  /** Update an existing container group (spec changes). */
  update?(providerId: string, input: Partial<CreateContainerGroupInput>): Promise<void>;

  /** Get a single sandbox's runtime status by provider ID. */
  getStatus?(providerId: string): Promise<ContainerGroupRuntime | null>;

  /** Delete a sandbox by provider ID. */
  delete(input: DeleteContainerGroupInput): Promise<void>;

  /** Fetch container stdout/stderr logs. */
  getLogs(input: GetContainerLogInput): Promise<ContainerLogResult>;
}

// ─── Virtual Node operations ───

export interface VirtualNodeInfo {
  readonly name: string;
  readonly provider: string;
  readonly capacity: NodeCapacity;
  readonly conditions: readonly NodeCondition[];
  readonly ready: boolean;
  readonly lastHeartbeatTime?: string;
}

export interface IVirtualNode {
  /** Register or refresh the virtual node in the cluster. */
  register(info: VirtualNodeInfo): Promise<void>;

  /** Deregister the virtual node. */
  deregister(): Promise<void>;

  /** Check node health. Returns false if the node should be marked NotReady. */
  ping(): Promise<boolean>;

  /** Report current node status (capacity, conditions). */
  status(): Promise<VirtualNodeInfo>;
}

// ─── DNS operations ───

export interface UpdateDnsRecordInput {
  readonly domain: string;
  readonly type: 'A' | 'CNAME';
  readonly value: string;
  readonly ttl: number;
  readonly proxied: boolean;
  /** Provider-specific record identifier (e.g. Cloudflare record ID). */
  readonly providerRecordId: string;
  /** Provider-specific zone identifier. */
  readonly zoneId: string;
}

export interface DeleteDnsRecordInput {
  readonly zoneId: string;
  readonly providerRecordId: string;
}

export interface IDnsProvider {
  /** Create or update a DNS record. */
  updateRecord(input: UpdateDnsRecordInput): Promise<void>;

  /** Delete a DNS record. */
  deleteRecord(input: DeleteDnsRecordInput): Promise<void>;
}

// ─── Metrics operations ───

export interface FetchMetricsInput {
  readonly region: string;
  readonly providerId: string;
  readonly periodSeconds?: number;
  readonly startTime?: number;
  readonly endTime?: number;
}

export interface FetchMetricsResult {
  readonly snapshots: readonly MetricSnapshot[];
}

export interface IMetricsProvider {
  /** Fetch monitoring metrics for a sandbox. */
  fetchMetrics(input: FetchMetricsInput): Promise<FetchMetricsResult>;
}

// ─── Provider capability declaration ───

/** Each provider declares which optional capabilities it supports. */
export interface ProviderCapabilities {
  readonly spotInstances: boolean;
  readonly nfsVolumes: boolean;
  readonly publicIpAutoAssign: boolean;
  readonly preemptible: boolean;
  /** Max seconds a sandbox can run before being forcibly terminated (0 = unlimited). */
  readonly maxRuntimeSeconds: number;
}

export interface IProviderRegistry {
  readonly container: IContainerProvider;
  readonly dns: IDnsProvider;
  readonly metrics: IMetricsProvider;
  readonly virtualNode?: IVirtualNode | undefined;
  readonly capabilities: ProviderCapabilities;
}
