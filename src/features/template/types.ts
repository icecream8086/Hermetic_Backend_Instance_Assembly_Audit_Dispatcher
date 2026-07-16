import type { PodSpec } from '../../core/pod/types.ts';

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
// 完整模板定义
// ═══════════════════════════════════════════

export interface Template {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly apiVersion: string;
  readonly kind: 'Pod';
  readonly metadata?: {
    readonly labels?: Record<string, string> | undefined;
    readonly annotations?: Record<string, string> | undefined;
  } | undefined;
  readonly spec: PodSpec;
  readonly dependsOn?: readonly string[] | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly creatorId?: string | undefined;
  readonly visibility?: TemplateVisibility | undefined;
  readonly singleton?: boolean | undefined;
  readonly instanceLimit?: TemplateInstanceLimit | undefined;
  readonly resourceBinding?: TemplateResourceBinding | undefined;
  /** @deprecated Use securityRefs instead. */
  readonly securityRef?: string | undefined;
  readonly securityRefs?: readonly string[] | undefined;
}

// ═══════════════════════════════════════════
// API 输入
// ═══════════════════════════════════════════

export interface CreateTemplateInput {
  name: string;
  description?: string | undefined;
  apiVersion?: string | undefined;
  metadata?: {
    labels?: Record<string, string> | undefined;
    annotations?: Record<string, string> | undefined;
  } | undefined;
  spec: PodSpec;
  dependsOn?: string[] | undefined;
  singleton?: boolean | undefined;
  instanceLimit?: TemplateInstanceLimit | undefined;
  resourceBinding?: TemplateResourceBinding | undefined;
  /** @deprecated Use securityRefs instead. */
  securityRef?: string | undefined;
  securityRefs?: string[] | undefined;
}

export interface UpdateTemplateInput {
  name?: string | undefined;
  description?: string | null | undefined;
  metadata?: {
    labels?: Record<string, string> | undefined;
    annotations?: Record<string, string> | undefined;
  } | undefined;
  spec?: PodSpec | undefined;
  dependsOn?: string[] | null | undefined;
  singleton?: boolean | undefined;
  instanceLimit?: TemplateInstanceLimit | null | undefined;
  resourceBinding?: TemplateResourceBinding | null | undefined;
  /** @deprecated Use securityRefs instead. */
  securityRef?: string | null | undefined;
  securityRefs?: string[] | null | undefined;
}
