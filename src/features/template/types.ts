import type { RegionId } from '../../core/region/types.ts';
import type { ProbeSpec } from '../../core/provider/types.ts';

// ─── Template type class ───

/** Who can see and use this template. */
export enum TemplateVisibility {
  /** Visible to all users in the same group (default). */
  PUBLIC = 'public',
  /** Only the creator can see and use this template. */
  PRIVATE = 'private',
}

/** Instance count limit strategy for a template. */
export interface TemplateInstanceLimit {
  /** 'fixed' = only 1 instance total (e.g., a unique domain) */
  readonly type: 'fixed' | 'perUser' | 'perSystem';
  /** Maximum number of instances. */
  readonly max: number;
}

/** Optional resource binding for this template (domain, port). */
export interface TemplateResourceBinding {
  readonly domain?: string | undefined;
  readonly port?: number | undefined;
}

// ─── Existing types ───

export interface TemplateContainer {
  readonly name: string;
  readonly image: string;
  readonly command?: readonly string[] | undefined;
  readonly args?: readonly string[] | undefined;
  readonly env?: readonly { name: string; value?: string; valueFrom?: string }[] | undefined;
  readonly ports?: readonly { containerPort: number; protocol?: string }[] | undefined;
  readonly resources?: {
    readonly requests?: { readonly cpu?: number; readonly memory?: number };
    readonly limits?: { readonly cpu?: number; readonly memory?: number; readonly gpu?: number };
  } | undefined;
  readonly livenessProbe?: ProbeSpec | undefined;
  readonly readinessProbe?: ProbeSpec | undefined;
  readonly providerOverrides?: Record<string, unknown> | undefined;
}

export interface TemplateStorage {
  readonly name: string;
  readonly type: 'oss' | 'nfs' | 'hostPath' | 'emptyDir';
  readonly mountPath: string;
  readonly oss?: { bucket: string; path: string; readOnly?: boolean } | undefined;
  readonly nfs?: { server: string; path: string; readOnly?: boolean } | undefined;
  readonly hostPath?: { path: string } | undefined;
  readonly size?: number | undefined;
  readonly providerOverrides?: Record<string, unknown> | undefined;
}

export interface TemplateSpec {
  readonly provider?: string | undefined;
  readonly account?: string | undefined;
  readonly region: RegionId;
  readonly zone?: string | undefined;
  readonly containers: readonly TemplateContainer[];
  readonly initContainers?: readonly TemplateContainer[] | undefined;
  readonly storage?: readonly TemplateStorage[] | undefined;
  readonly network?: {
    readonly allocatePublicIp?: boolean;
    readonly publicIpBandwidth?: number;
    readonly securityGroupId?: string;
    readonly subnetIds?: readonly string[] | undefined;
  } | undefined;
  readonly spotStrategy?: string | undefined;
  readonly restartPolicy?: string | undefined;
  readonly providerOverrides?: Record<string, unknown> | undefined;
  readonly extensions?: Record<string, unknown> | undefined;
  readonly userGroupIds?: string[] | undefined;

  // ─── Template type class fields ───
  readonly visibility?: TemplateVisibility | undefined;
  readonly instanceLimit?: TemplateInstanceLimit | undefined;
  readonly resourceBinding?: TemplateResourceBinding | undefined;
}

export interface SandboxTemplate {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly spec: TemplateSpec;
  readonly dependsOn?: string[] | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** The user who created this template. Used for private template access control. */
  readonly creatorId?: string | undefined;
}

export interface CreateTemplateInput {
  name: string;
  description?: string | undefined;
  spec: TemplateSpec;
  dependsOn?: string[] | undefined;
}

export interface UpdateTemplateInput {
  name?: string | undefined;
  description?: string | null | undefined;
  spec?: TemplateSpec | undefined;
  dependsOn?: string[] | null | undefined;
}
