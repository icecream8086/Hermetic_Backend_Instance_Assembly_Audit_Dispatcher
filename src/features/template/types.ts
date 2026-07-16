import { z } from 'zod';
import { TemplateSchema } from './response-schema.ts';

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
// 完整模板定义 — TemplateSchema 为单一信源
// ═══════════════════════════════════════════

export type Template = z.infer<typeof TemplateSchema>;

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
