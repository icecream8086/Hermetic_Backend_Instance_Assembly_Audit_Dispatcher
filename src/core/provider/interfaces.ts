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
import type { InstanceId } from '../region/instance.ts';
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

/** Provider lifecycle model — declared by each provider at construction.
 *  Callers MUST query this before making lifecycle decisions (stop/start/GC). */
export interface ContainerLifecycle {
  /** stop() is terminal (same as delete). ECI: true, Podman: false. */
  readonly stopIsDelete: boolean;
  /** Can a stopped sandbox be restarted? ECI: false, Podman: true. */
  readonly startable: boolean;
  /** Can the provider report per-container health probe results? ECI: false, Podman: true. */
  readonly healthProbes: boolean;
  /** Does create() return before the sandbox is actually Running? ECI: true, Podman/Stub: false. */
  readonly asyncInit: boolean;
}

export interface IContainerProvider {
  /** Provider lifecycle semantics — callers query this before stop/start/GC. */
  readonly lifecycle: ContainerLifecycle;

  /**
   * Create a container (or container group, depending on provider).
   *
   * Accepts CreateContainerGroupInput because all providers need the same
   * data shape (containers, resources, network). Lifecycle semantics differ:
   * - Podman: creates a single Docker container (only the first container in
   *   the input array is used; extra containers are ignored).
   * - ECI: creates a ContainerGroup — all containers in the array are included.
   *
   * Returns the provider-assigned ID.
   */
  create(input: CreateContainerGroupInput): Promise<{ providerId: string }>;

  /** Query sandboxes by filters. */
  describe(input: DescribeContainerGroupsInput): Promise<DescribeContainerGroupsResult>;

  /** Update an existing container group (spec changes). */
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- provider interface: input fields are naturally optional for partial updates
  update?(providerId: string, input: Partial<CreateContainerGroupInput>): Promise<void>;

  /** Get a single sandbox's runtime status by provider ID. */
  getStatus?(providerId: string): Promise<ContainerGroupRuntime | null>;

  /** Delete a sandbox by provider ID. */
  delete(input: DeleteContainerGroupInput): Promise<void>;

  /** Fetch container stdout/stderr logs. */
  getLogs(input: GetContainerLogInput): Promise<ContainerLogResult>;

  /** Gracefully stop a container with optional timeout. */
  stop?(providerId: string, timeoutSeconds?: number): Promise<void>;

  /** Start a stopped container. */
  start?(providerId: string): Promise<void>;

  /** Restart a container with optional timeout. */
  restart?(providerId: string, timeoutSeconds?: number): Promise<void>;

  /** Force-kill a container with optional signal. */
  kill?(providerId: string, signal?: string): Promise<void>;

  /** Pause a running container (freeze cgroups). */
  pause?(providerId: string): Promise<void>;

  /** Unpause a paused container. */
  unpause?(providerId: string): Promise<void>;

  /** Wait for a container to reach a specific state. */
  wait?(providerId: string, condition?: 'not-running' | 'next-exit'): Promise<{ statusCode: number }>;

  /** Execute a command inside a running container. */
  exec?(providerId: string, cmd: readonly string[], containerName?: string): Promise<{ execId: string; webSocketUri?: string | undefined }>;

  /** Rename a container. */
  rename?(providerId: string, newName: string): Promise<void>;

  /** Get live resource usage stats. */
  stats?(providerId: string): Promise<{ cpuUsage: number; memoryUsage: number; networkIO?: { rx: number; tx: number } | undefined }>;

  /** List running processes inside a container. */
  top?(providerId: string, psArgs?: string): Promise<{ processes: readonly (readonly string[])[] }>;
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

/** Optional pagination / filter params for list(). */
export interface ListImagesOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly search?: string;
}

export interface IImageProvider {
  /** Pull an image from a registry. Returns image info.
   *  If clusterId is provided, the provider may route to a cluster-specific endpoint. */
  pull(image: string, clusterId?: string): Promise<ImageInfo>;

  /** List locally available images. */
  list(options?: ListImagesOptions): Promise<readonly ImageInfo[]>;

  /** Inspect a single image by ID or tag. */
  inspect(id: string): Promise<ImageInfo | null>;

  /** Remove an image. */
  remove(id: string): Promise<void>;

  /** Push an image to a registry. Optional — provider may not support it. */
  push?(imageOrId: string, credential?: { server: string; userName: string; password: string }): Promise<ImageInfo>;

  /** Search for images on a registry. */
  search?(term: string, options?: { limit?: number | undefined }): Promise<readonly { name: string; description?: string | undefined; isOfficial?: boolean | undefined }[]>;

  /** Tag an image with a new name. */
  tag?(id: string, tag: string): Promise<void>;

  /** Get image layer history. */
  history?(id: string): Promise<readonly { id: string; created?: number | undefined; createdBy?: string | undefined; size?: number | undefined }[]>;

  /** Prune unused images. */
  prune?(options?: { dangling?: boolean | undefined }): Promise<{ reclaimed: number }>;

  /** Build an image from a Dockerfile-like context. */
  build?(context: unknown, options?: { dockerfile?: string | undefined; tag?: string | undefined }): Promise<ImageInfo>;
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
  /** Per-rule bandwidth limit (Mbps). 0 = block, undefined = no limit. */
  readonly rateLimit?: number | undefined;
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
  /** Default container provider (resolved from first available online instance). */
  readonly container: IContainerProvider;
  readonly dns: IDnsProvider;
  readonly metrics: IMetricsProvider;
  /** Default image provider. */
  readonly image: IImageProvider;
  readonly virtualNode?: IVirtualNode | undefined;
  readonly networkPolicy?: INetworkPolicyProvider | undefined;
  readonly groupContainer?: IContainerGroupProvider | undefined;
  readonly capabilities: ProviderCapabilities;

  /** Get a provider by type name ('stub' | 'podman' | 'alibaba'). */
  provider(name: string): ProviderEntry | undefined;

  /** List available provider types. Deprecated: use /api/topology/instances. */
  availableProviders(): readonly ProviderEntry[];

  /** S3: get a named S3 provider account. */
  s3Account(name?: string): IS3Provider | undefined;

  /** S3: list all S3 account names. */
  listS3Accounts(): string[];

  /** Get raw ECI OpenAPI client for the default Alibaba account. */
  rawEciApi(): unknown;

  /** Get CR (Container Registry) OpenAPI client. */
  crApi(): unknown;

  /** Get OSS management-plane OpenAPI client (bucket CRUD, policy, etc.). */
  ossOpenApi(): unknown;

  // ─── ComputeInstance-aware resolution ───

  /** Resolve a container provider for a specific instance.
   *  Falls back to default container provider. */
  resolveContainer(instanceId?: InstanceId): Promise<IContainerProvider>;

  /** Resolve an image provider for a specific instance. */
  resolveImage(instanceId?: InstanceId): Promise<IImageProvider>;

  /** Resolve a container group provider for a specific instance. */
  resolveGroup(instanceId?: InstanceId): Promise<IContainerGroupProvider | undefined>;

  /** Resolve a raw ECI API client for a specific instance. */
  resolveRawEciApi(instanceId?: InstanceId): Promise<unknown>;

  /** Resolve a CR (Container Registry) API client for a specific instance. */
  resolveCrApi(instanceId?: InstanceId): Promise<unknown>;

  /** Resolve an OSS management-plane API client for a specific instance. */
  resolveOssOpenApi(instanceId?: InstanceId): Promise<unknown>;
}

// ─── Container group / Pod operations ───
// Separate from IContainerProvider because the lifecycle is different:
// - Podman: creates a libpod pod (pod create → share net/uts/ipc → start).
//   All containers in the spec are included in the pod.
// - ECI: creates a ContainerGroup. All containers share the same ENI.
//
// Accepts the same CreateContainerGroupInput type as IContainerProvider
// because the data shape is identical. The semantic difference is in how
// the provider groups the containers (pod vs. container group vs. individual).

import type { PodSpec } from '../pod/types.ts';

export interface IContainerGroupProvider {
  /**
   * Create a pod from the K8s-aligned PodSpec (v3, preferred).
   * Provider selects the appropriate codec internally.
   */
  createPod(spec: PodSpec): Promise<{ providerId: string }>;

  /**
   * Stop a container group.
   * - ECI: 停止即释放（terminal），等同于删除，资源不可恢复
   * - Podman: 停止进程但保留 pod 元数据，可重新 start
   */
  stopGroup(providerId: string): Promise<void>;

  /** Start a stopped container group. */
  startGroup?(providerId: string): Promise<void>;

  /** Delete a container group by provider ID (terminal). */
  deleteGroup(providerId: string): Promise<void>;

  /** Get detailed status of a container group. */
  getGroupStatus(providerId: string): Promise<ContainerGroupRuntime | null>;

  /** List container groups with optional filters. */
  describeGroups(input: DescribeContainerGroupsInput): Promise<DescribeContainerGroupsResult>;
}
