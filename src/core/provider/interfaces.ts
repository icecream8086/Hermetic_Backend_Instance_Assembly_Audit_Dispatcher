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
import type { RegionId } from '../region/types.ts';
import type { IS3Provider } from './s3.ts';

// ─── Container operations ───

export interface DescribeContainerGroupsInput {
  readonly region: RegionId;
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
  readonly region: RegionId;
  readonly providerId: string;
}

export interface GetContainerLogInput {
  readonly region: RegionId;
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

// ─── Image operations ───

export interface ImageInfo {
  readonly id: string;
  readonly tags: readonly string[];
  readonly created?: number | undefined;
  readonly size?: number | undefined;
  readonly architecture?: string | undefined;
  readonly os?: string | undefined;
  readonly layers?: number | undefined;
}

export interface IImageProvider {
  /** Pull an image from a registry. Returns image info. */
  pull(image: string): Promise<ImageInfo>;

  /** List locally available images. */
  list(): Promise<readonly ImageInfo[]>;

  /** Inspect a single image by ID or tag. */
  inspect(id: string): Promise<ImageInfo | null>;

  /** Remove an image. */
  remove(id: string): Promise<void>;
}

// ─── Metrics operations ───

export interface FetchMetricsInput {
  readonly region: RegionId;
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

// ─── Network policy (multi-tenant isolation) ───

export interface NetworkRule {
  readonly direction: 'ingress' | 'egress';
  readonly protocol?: 'tcp' | 'udp' | undefined;
  readonly port?: number | undefined;
  readonly cidr?: string | undefined;
  readonly action: 'allow' | 'deny';
}

export interface INetworkPolicyProvider {
  /** Ensure an isolated network exists for a tenant. Returns network name/ID. */
  ensureNetwork(tenantId: string): Promise<string>;
  /** Remove a network when no longer needed. */
  removeNetwork(networkId: string): Promise<void>;
  /** Optionally apply ingress/egress rules to a network. */
  applyRules?(networkId: string, rules: readonly NetworkRule[]): Promise<void>;
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

export interface ProviderEntry {
  readonly name: string;
  readonly container: IContainerProvider;
  readonly image: IImageProvider;
}

export interface IProviderRegistry {
  readonly container: IContainerProvider;
  readonly dns: IDnsProvider;
  readonly metrics: IMetricsProvider;
  readonly image: IImageProvider;
  readonly virtualNode?: IVirtualNode | undefined;
  readonly networkPolicy?: INetworkPolicyProvider | undefined;
  readonly capabilities: ProviderCapabilities;

  /** Get a provider by type name ('stub' | 'podman' | 'alibaba'). */
  provider(name: string): ProviderEntry | undefined;

  /** Get a credential account by logical name ('prod' | 'dev' | ...). */
  account(name: string): ProviderEntry | undefined;

  /** List all registered credential account names. */
  listAccounts(): string[];

  /** List all registered providers by type. */
  availableProviders(): readonly ProviderEntry[];

  /** S3: get a named S3 provider account. */
  s3Account(name?: string): IS3Provider | undefined;

  /** S3: list all S3 account names. */
  listS3Accounts(): string[];
}

// ─── Container group operations (Pod-level abstraction) ───
// Separate from IContainerProvider because creating a container group/pod
// is fundamentally different from creating individual containers.
// - Podman: uses libpod pods API (pod create → add containers → start pod)
// - ECI:   uses ContainerGroup API natively (single request)

export interface IContainerGroupProvider {
  /** Create a container group (pod) from a multi-container spec. */
  createGroup(input: CreateContainerGroupInput): Promise<{ providerId: string }>;

  /** Delete a container group by provider ID. */
  deleteGroup(providerId: string): Promise<void>;

  /** Get detailed status of a container group. */
  getGroupStatus(providerId: string): Promise<ContainerGroupRuntime | null>;

  /** List container groups with optional filters. */
  describeGroups(input: DescribeContainerGroupsInput): Promise<DescribeContainerGroupsResult>;
}
