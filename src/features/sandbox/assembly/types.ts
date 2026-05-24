import type {
  BaseTemplate,
  DagEdge,
} from '../base.ts';
import type {
  VolumeType,
  NFSVolumeConfig,
  ContainerConfig,
  CreateSandboxInput,
} from '../types.ts';

// ─── Template discriminator ───

export enum TemplateKind {
  Volume = 'volume',
  Container = 'container',
  Resource = 'resource',
  Assembly = 'assembly',
}

// ─── VolumeTemplate ───

export interface VolumeTemplateSpec {
  readonly type: VolumeType;
  readonly nfs?: NFSVolumeConfig;
}

export interface VolumeTemplate extends BaseTemplate<TemplateKind.Volume> {
  readonly kind: TemplateKind.Volume;
  readonly spec: VolumeTemplateSpec;
}

// ─── ContainerTemplate ───

export interface ContainerTemplate extends BaseTemplate<TemplateKind.Container> {
  readonly kind: TemplateKind.Container;
  readonly spec: ContainerConfig;
}

// ─── ResourceTemplate ───

export enum ResourceType {
  Dns = 'dns',
  Network = 'network',
  SecurityGroup = 'securityGroup',
}

export interface ResourceTemplate extends BaseTemplate<TemplateKind.Resource> {
  readonly kind: TemplateKind.Resource;
  readonly resourceType: ResourceType;
  readonly spec: Record<string, unknown>;
}

// ─── AssemblyTemplate ───

export interface AssemblyTemplate extends BaseTemplate<TemplateKind.Assembly> {
  readonly kind: TemplateKind.Assembly;
  /** Templates that form this assembly, resolved in declaration order. */
  readonly components: readonly DagEdge[];
  /** Static overrides applied after all components are merged. */
  readonly overrides?: Partial<CreateSandboxInput>;
}

// ─── Discriminated union ───

export type Template =
  | VolumeTemplate
  | ContainerTemplate
  | ResourceTemplate
  | AssemblyTemplate;

// ─── Resolver result ───

export interface ResolveError {
  /** Template name where the error occurred. */
  readonly templateName: string;
  readonly message: string;
}

export interface ResolveSuccess {
  readonly success: true;
  readonly config: CreateSandboxInput;
}

export interface ResolveFailure {
  readonly success: false;
  readonly errors: readonly ResolveError[];
}

export type ResolveResult = ResolveSuccess | ResolveFailure;

// ─── Pod-level types (docker-compose-like spec) ───

/** Shared namespaces for a Pod (analogous to Podman PodBasicConfig.SharedNamespaces). */
export enum SharedNamespace {
  NET = 'net',
  UTS = 'uts',
  IPC = 'ipc',
  CGROUP = 'cgroup',
}

/** Pod exit strategy — what happens when one container stops. */
export enum PodExitPolicy {
  STOP = 'stop',
  CONTINUE = 'continue',
}

/** Resource limit expressed as a string (e.g. "1.0" for 1 CPU, "512Mi" for memory). */
export interface ResourceLimits {
  readonly cpu?: string | undefined;
  readonly memory?: string | undefined;
}

/** Port mapping — exposed container port to optional host port. */
export interface PortMapping {
  readonly containerPort: number;
  readonly hostPort?: number | undefined;
  readonly protocol?: 'tcp' | 'udp' | undefined;
}

/** A service within a PodSpec — analogous to a docker-compose service. */
export interface ServiceDefinition {
  readonly image: string;
  readonly command?: string | readonly string[] | undefined;
  readonly environment?: Record<string, string> | undefined;
  readonly ports?: readonly PortMapping[] | undefined;
  readonly volumes?: readonly {
    readonly source: string;
    readonly destination: string;
    readonly readOnly?: boolean | undefined;
  }[] | undefined;
  readonly resources?: ResourceLimits | undefined;
  readonly dependsOn?: readonly string[] | undefined;
  readonly labels?: Record<string, string> | undefined;
  readonly healthCheck?: {
    readonly test: readonly string[];
    readonly intervalSeconds?: number | undefined;
    readonly timeoutSeconds?: number | undefined;
    readonly retries?: number | undefined;
    readonly startPeriodSeconds?: number | undefined;
  } | undefined;
}

/** A Pod-level specification — analogous to a docker-compose file or Podman's PodSpecGenerator. */
export interface PodSpec {
  readonly name: string;
  readonly hostname?: string | undefined;
  readonly labels?: Record<string, string> | undefined;
  readonly sharedNamespaces?: readonly SharedNamespace[] | undefined;
  readonly exitPolicy?: PodExitPolicy | undefined;
  readonly infraImage?: string | undefined;
  readonly resources?: ResourceLimits | undefined;
  readonly services: Record<string, ServiceDefinition>;
}

// ─── DAG execution plan types ───

/** A single task node in the container orchestration DAG. */
export interface TaskNode {
  readonly id: string;
  readonly dependsOn: readonly string[];
  /** Container image reference. */
  readonly image: string;
  /** Container arguments. */
  readonly args?: readonly string[] | undefined;
  /** Environment variables. */
  readonly env?: Record<string, string> | undefined;
  /** Ports to expose. */
  readonly ports?: readonly {
    readonly containerPort: number;
    readonly hostPort?: number | undefined;
    readonly protocol?: 'tcp' | 'udp' | undefined;
  }[] | undefined;
  /** Network mode override (e.g. 'container:<infra-id>'). */
  readonly networkMode?: string | undefined;
  /** CPU limit (fractional cores). */
  readonly cpu?: number | undefined;
  /** Memory limit (MB). */
  readonly memory?: number | undefined;
  /** Health check spec. */
  readonly healthCheck?: {
    readonly test: readonly string[];
    readonly intervalSeconds?: number | undefined;
    readonly timeoutSeconds?: number | undefined;
    readonly retries?: number | undefined;
    readonly startPeriodSeconds?: number | undefined;
  } | undefined;
  /** Provider-specific overrides. */
  readonly providerOverrides?: Record<string, unknown> | undefined;
}

/** Result of executing a single task node. */
export interface TaskResult {
  readonly nodeId: string;
  readonly success: boolean;
  readonly providerId?: string | undefined;
  readonly error?: string | undefined;
}

/** Execution plan produced by PodResolver and consumed by DagOrchestrator. */
export interface ExecutionPlan {
  readonly tasks: readonly TaskNode[];
  /** Infra container provider ID, if one was created. */
  readonly infraId?: string | undefined;
}

/** Final result of executing an entire plan. */
export interface ExecutionPlanResult {
  readonly success: boolean;
  readonly results: readonly TaskResult[];
  readonly infraId?: string | undefined;
}
