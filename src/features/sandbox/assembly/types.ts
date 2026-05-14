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
