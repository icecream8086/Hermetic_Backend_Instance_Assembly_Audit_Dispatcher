import type { Gid } from '../users/types.ts';

declare const SYSGROUP_ID_BRAND: unique symbol;
export type SysGroupId = string & { readonly [SYSGROUP_ID_BRAND]: true };

export function generateSysGroupId(): SysGroupId {  return `sysgrp_${crypto.randomUUID()}` as SysGroupId;
}

export interface PermissionRule {
  effect: 'allow' | 'deny';
  actions: string[];
  resource?: string | undefined;
  priority: number;
}

export interface SysGroup {
  id: SysGroupId;
  /** Numeric group ID — RHEL §1 GID. */
  gid: Gid;
  name: string;
  description?: string | undefined;
  rules: PermissionRule[];
  priority: number;
  /** Other SysGroup IDs this group depends on (inherits rules). */
  dependsOn: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateSysGroupInput {
  name: string;
  description?: string | undefined;
  rules: PermissionRule[];
  priority?: number | undefined;
  dependsOn?: string[] | undefined;
}

export interface UpdateSysGroupInput {
  name?: string | undefined;
  description?: string | null | undefined;
  rules?: PermissionRule[] | undefined;
  priority?: number | undefined;
  dependsOn?: string[] | null | undefined;
}
