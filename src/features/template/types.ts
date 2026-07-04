import type { RegionId, ZoneId } from '../../core/region/types.ts';
import type { InstanceId } from '../../core/region/instance.ts';
import type { ProbeSpec, OciImageRef } from '../../core/provider/types.ts';
import type { PodSpec } from './assembly/types.ts';

// ═══════════════════════════════════════════
// 模板信息 — 模板自身的元数据
// ═══════════════════════════════════════════

/** Who can see and use this template. */
export enum TemplateVisibility {
  PUBLIC = 'public',
  PRIVATE = 'private',
}

/** Instance count limit strategy. */
export interface TemplateInstanceLimit {
  readonly type: 'fixed' | 'perUser' | 'perSystem';
  readonly max: number;
}

/** Domain:port binding — exclusive claim on first apply. */
export interface TemplateResourceBinding {
  readonly domain?: string | undefined;
  readonly port?: number | undefined;
}

// ═══════════════════════════════════════════
// 容器信息 — 无状态核心（tag: container）
// ═══════════════════════════════════════════

/** 无状态容器定义 — 不包含 probes/storage/providerOverrides */
export interface ContainerDef {
  readonly name: string;
  /** 镜像引用 — 支持 name:tag（如 "nginx:latest"）、sha256 digest、完整 registry URL */
  readonly image: OciImageRef;
  readonly command?: readonly string[] | undefined;
  readonly args?: readonly string[] | undefined;
  readonly env?: readonly { name: string; value?: string; valueFrom?: string }[] | undefined;
  readonly ports?: readonly { containerPort: number; protocol?: string }[] | undefined;
  readonly resources?: {
    readonly requests?: { readonly cpu?: number; readonly memory?: number };
    readonly limits?: { readonly cpu?: number; readonly memory?: number; readonly gpu?: number; readonly gpuType?: string };
  } | undefined;
}

/** 容器组定义 — 纯无状态，不包含 probes/storage/providerOverrides */
export interface ContainerSpec {
  readonly region: RegionId;
  readonly zone?: ZoneId | undefined;
  readonly instanceId?: InstanceId | undefined;
  readonly account?: string | undefined;
  readonly restartPolicy?: string | undefined;
  readonly containers: readonly ContainerDef[];
  readonly initContainers?: readonly ContainerDef[] | undefined;
}

// ═══════════════════════════════════════════
// 健康检查 — 独立于容器定义
// ═══════════════════════════════════════════

/** 健康检查目标 — 作用到哪个容器 */
export function healthCheckTarget(type: 'container' | 'init', name: string): string {
  return `${type}:${name}`;
}

export interface HealthCheckDef {
  /** 检查标识名 */
  readonly name: string;
  /** 作用目标，如 "container:nginx" / "init:init-db" */
  readonly target: string;
  /** 检查类型 */
  readonly type: 'liveness' | 'readiness' | 'startup';
  /** 探针定义 */
  readonly probe: ProbeSpec;
  readonly initialDelaySeconds?: number | undefined;
  readonly periodSeconds?: number | undefined;
  readonly timeoutSeconds?: number | undefined;
  readonly successThreshold?: number | undefined;
  readonly failureThreshold?: number | undefined;
}

// ═══════════════════════════════════════════
// 网络 — 公共基础设施层
// ═══════════════════════════════════════════

export interface NetworkSpec {
  /** 网络模式: "public"=公网可达, "private"=仅内网, "vpc"=虚拟私有网络 */
  readonly mode?: 'public' | 'private' | 'vpc' | undefined;
  /** 公网 IP 配置 */
  readonly publicIp?: {
    readonly allocate?: boolean;
    readonly bandwidth?: number;     // Mbps
  } | undefined;
  /** 虚拟私有网络（VPC） */
  readonly vpc?: {
    readonly id?: string;
    readonly instanceId?: string;
    readonly subnetIds?: readonly string[];
    readonly securityGroupId?: string;
  } | undefined;
  /** 指定 IP 地址。设了则使用此 IP，不设则由系统从 subnetIds 自动分配。 */
  readonly ipAddress?: string | undefined;
  // 未来: dns?, loadBalancer?, privateLink?
  // bandwidth 已合并到 SecurityGroup，创建 sandbox 时通过 securityGroupId 自动继承
}

// ═══════════════════════════════════════════
// 扩展功能 — 存储、调度、厂商参数、生命周期策略
// ═══════════════════════════════════════════

export interface ContainerSecretBinding {
  /** ContainerSecret.name */
  readonly name: string;
  /** 要挂载的 key。空 = 全部。 */
  readonly keys?: readonly string[] | undefined;
}

export interface TemplateStorage {
  readonly name: string;
  readonly type: 'oss' | 'nfs' | 'emptyDir' | 'disk' | 'configMap' | 'secret';
  readonly mountPath: string;
  readonly instanceId: string;
  /** Reference a pre-existing Volume entity. When set, the volume's config (nfs/disk/configMap/secret) overrides inline fields. */
  readonly volumeId?: string | undefined;
  /** Reference a pre-existing Bucket entity. When set, overrides inline oss.bucket. */
  readonly bucketId?: string | undefined;
  readonly oss?: { bucket: string; path: string; readOnly?: boolean } | undefined;
  readonly nfs?: { server: string; path: string; readOnly?: boolean } | undefined;
  readonly emptyDir?: {
    readonly sizeLimit: string;
    readonly medium?: 'Default' | 'Memory' | undefined;
  } | undefined;
  readonly disk?: { diskId: string; fsType?: string; sizeGiB?: number; readOnly?: boolean; deleteWithInstance?: boolean } | undefined;
  readonly configMap?: { name: string; env: readonly { key: string; value: string }[] } | undefined;
  readonly secret?: { name: string; items?: readonly { key: string; path: string; mode?: number }[] } | undefined;
  readonly size?: number | undefined;
  /** 引用 SecurityResource 的名称列表（S3 存储策略） */
  readonly securityRefs?: readonly string[] | undefined;
  /** 引用 ContainerSecret 列表（平台密钥注入） */
  readonly containerSecretRefs?: readonly ContainerSecretBinding[] | undefined;
  readonly providerOverrides?: Record<string, unknown> | undefined;
}

/** 扩展功能 — 存储/调度/厂商参数/生命周期策略统一入口 */
export interface TemplateExtensions {
  /** 存储卷 */
  readonly storage?: readonly TemplateStorage[];
  /** 厂商透传参数 (Alibaba spotStrategy goes here, not at extensions level) */
  readonly providerOverrides?: Record<string, unknown>;
  /** 健康检查失败最大重试次数 (-1 = 白名单永不删除) */
  readonly healthMaxRetries?: number;
  /** 创建沙箱后自动启动 */
  readonly autoStart?: boolean;
  /** 启用 Web Terminal */
  readonly webTerminal?: boolean;
  /** 生命周期钩子 */
  readonly lifecycleHooks?: Record<string, unknown>;
}

// ═══════════════════════════════════════════
// 完整模板定义
// ═══════════════════════════════════════════

export interface Template {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;

  // ── 身份标识 ──
  /** 模板 API 版本，如 "hbi-aad/v1" */
  readonly apiVersion: string;
  /** 模板类型: "Container"=单容器组, "ContainerGroup"=多服务编排 */
  readonly kind: 'Container' | 'ContainerGroup';
  /** 元数据: 作者/标签/注解 */
  readonly metadata?: {
    readonly author?: string | undefined;
    readonly labels?: Record<string, string> | undefined;
    readonly annotations?: Record<string, string> | undefined;
  } | undefined;

  // ── DAG 继承 ──
  readonly dependsOn?: string[] | undefined;

  // ── 时间戳 ──
  readonly createdAt: number;
  readonly updatedAt: number;

  // ── 归属与访问控制 ──
  readonly creatorId?: string | undefined;
  readonly visibility?: TemplateVisibility | undefined;
  readonly userGroupIds?: string[] | undefined;
  /** 单例模式 — 与 instanceLimit 互斥，开启后自动限制为 1 个运行中实例 */
  readonly singleton?: boolean | undefined;
  readonly instanceLimit?: TemplateInstanceLimit | undefined;
  readonly resourceBinding?: TemplateResourceBinding | undefined;

  // ── 容器信息（无状态核心, kind=Container 时使用） ──
  readonly container?: ContainerSpec | undefined;

  // ── 健康检查（独立于容器） ──
  readonly healthChecks?: readonly HealthCheckDef[] | undefined;

  // ── 网络（公共基础设施层） ──
  readonly network?: NetworkSpec | undefined;

  // ── 扩展功能 ──
  readonly extensions?: TemplateExtensions | undefined;

  // ── 容器组规格（kind=ContainerGroup 时使用，docker-compose 风格） ──
  readonly podSpec?: PodSpec | undefined;
}

// ═══════════════════════════════════════════
// API 输入
// ═══════════════════════════════════════════

export interface CreateTemplateInput {
  name: string;
  description?: string | undefined;
  apiVersion?: string | undefined;
  kind?: 'Container' | 'ContainerGroup' | undefined;
  metadata?: {
    author?: string | undefined;
    labels?: Record<string, string> | undefined;
    annotations?: Record<string, string> | undefined;
  } | undefined;
  singleton?: boolean | undefined;
  instanceLimit?: TemplateInstanceLimit | undefined;
  resourceBinding?: TemplateResourceBinding | undefined;
  container?: ContainerSpec | undefined;
  healthChecks?: readonly HealthCheckDef[] | undefined;
  network?: NetworkSpec | undefined;
  extensions?: TemplateExtensions | undefined;
  dependsOn?: string[] | undefined;
  podSpec?: PodSpec | undefined;
}

export interface UpdateTemplateInput {
  name?: string | undefined;
  description?: string | null | undefined;
  metadata?: {
    author?: string | undefined;
    labels?: Record<string, string> | undefined;
    annotations?: Record<string, string> | undefined;
  } | undefined;
  singleton?: boolean | undefined;
  instanceLimit?: TemplateInstanceLimit | null | undefined;
  resourceBinding?: TemplateResourceBinding | null | undefined;
  container?: ContainerSpec | undefined;
  healthChecks?: readonly HealthCheckDef[] | undefined;
  network?: NetworkSpec | undefined;
  extensions?: TemplateExtensions | undefined;
  dependsOn?: string[] | null | undefined;
  podSpec?: PodSpec | null | undefined;
}
