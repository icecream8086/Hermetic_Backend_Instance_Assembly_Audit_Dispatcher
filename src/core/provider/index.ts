export type {
  IContainerProvider,
  IDnsProvider,
  IMetricsProvider,
  IProviderRegistry,
  IVirtualNode,
  VirtualNodeInfo,
  ProviderCapabilities,
  DescribeContainerGroupsInput,
  DescribeContainerGroupsResult,
  DeleteContainerGroupInput,
  GetContainerLogInput,
  ContainerLogResult,
  UpdateDnsRecordInput,
  DeleteDnsRecordInput,
  FetchMetricsInput,
  FetchMetricsResult,
} from './interfaces.ts';

export type {
  ContainerGroupStatus,
  ContainerGroupRuntime,
  ContainerGroupNetwork,
  ContainerGroupRuntimeEvent,
  ContainerId,
  OciContainer,
  OciContainerStatus,
  OciHealthStatus,
  OciImageRef,
  VolumeRuntimeInfo,
  AssociatedResource,
  AssociatedResourceType,
  MetricSnapshot,
  CPUMetrics,
  MemoryMetrics,
  NetworkMetrics,
  DiskMetrics,
  ContainerMetrics,
  CreateContainerGroupInput,
  ContainerCreateConfig,
  ContainerGroupNetworkInput,
  VolumeConfigInput,
  VolumeMountConfig,
  NodeCapacity,
  NodeCondition,
  EnvVar,
  ResourceRequirements,
  ProbeSpec,
} from './types.ts';

export { createProviderRegistry } from './factory.ts';
export type { ProviderCredentials } from './factory.ts';

export type {
  IS3Provider,
} from './s3.ts';

export { createS3Provider } from './s3-factory.ts';
export type { S3Credentials } from './s3-factory.ts';

export type {
  S3ProviderType,
  S3PutObjectInput,
  S3GetObjectResult,
  S3ObjectInfo,
  S3ListObjectsResult,
  S3ProviderConfig,
} from './s3-types.ts';
