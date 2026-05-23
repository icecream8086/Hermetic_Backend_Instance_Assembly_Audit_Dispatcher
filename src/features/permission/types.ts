import type { PolicyId } from '../../core/permission/types.ts';
import { createPolicyId } from '../../core/permission/types.ts';

export { createPolicyId };
export type { PolicyId };

declare const PERMISSION_ID_BRAND: unique symbol;
export type PermissionId = string & { readonly [PERMISSION_ID_BRAND]: true };

export function createPermissionId(raw: string): PermissionId {
  if (!raw) throw new TypeError('PermissionId must not be empty');
  return raw as PermissionId;
}

export function generatePermissionId(): PermissionId {
  return `perm_${crypto.randomUUID()}` as PermissionId;
}

export type PolicyEffect = 'allow' | 'deny';

// ─── Individual policy (existing) ───

export interface StoredPolicy {
  id: PolicyId;
  name: string;
  description?: string | undefined;
  effect: PolicyEffect;
  userId?: string | undefined;
  role?: string | undefined;
  actions: string[];
  resource?: string | undefined;
  priority: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreatePolicyInput {
  name: string;
  description?: string | undefined;
  effect: PolicyEffect;
  userId?: string | undefined;
  role?: string | undefined;
  actions?: string[] | undefined;
  resource?: string | undefined;
  priority?: number | undefined;
}

export interface UpdatePolicyInput {
  name?: string | undefined;
  description?: string | undefined;
  effect?: PolicyEffect | undefined;
  userId?: string | null | undefined;
  role?: string | null | undefined;
  actions?: string[] | undefined;
  resource?: string | null | undefined;
  priority?: number | undefined;
  enabled?: boolean | undefined;
}

// ─── User group ───

declare const USERGROUP_ID_BRAND: unique symbol;
export type UserGroupId = string & { readonly [USERGROUP_ID_BRAND]: true };

export function generateUserGroupId(): UserGroupId {
  return `usergrp_${crypto.randomUUID()}` as UserGroupId;
}

export interface UserGroup {
  id: UserGroupId;
  name: string;
  description?: string | undefined;
  memberIds: string[];
  /** Other UserGroup IDs this group depends on (inherits members). */
  dependsOn: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateUserGroupInput {
  name: string;
  description?: string | undefined;
  memberIds?: string[] | undefined;
  dependsOn?: string[] | undefined;
}

export interface UpdateUserGroupInput {
  name?: string | undefined;
  description?: string | null | undefined;
  memberIds?: string[] | undefined;
  dependsOn?: string[] | null | undefined;
}

// ─── Permission rule (within a permission group) ───

export interface PermissionRule {
  effect: PolicyEffect;
  actions: string[];
  resource?: string | undefined;
  priority: number;
}

// ─── Permission group ───

declare const PERMGROUP_ID_BRAND: unique symbol;
export type PermGroupId = string & { readonly [PERMGROUP_ID_BRAND]: true };

export function generatePermGroupId(): PermGroupId {
  return `permgrp_${crypto.randomUUID()}` as PermGroupId;
}

export interface PermissionGroup {
  id: PermGroupId;
  name: string;
  description?: string | undefined;
  rules: PermissionRule[];
  userGroupIds: string[];
  userIds: string[];
  /** Other PermissionGroup IDs this group depends on (inherits rules). */
  dependsOn: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CreatePermGroupInput {
  name: string;
  description?: string | undefined;
  rules: PermissionRule[];
  userGroupIds?: string[] | undefined;
  userIds?: string[] | undefined;
  dependsOn?: string[] | undefined;
}

export interface UpdatePermGroupInput {
  name?: string | undefined;
  description?: string | null | undefined;
  rules?: PermissionRule[] | undefined;
  userGroupIds?: string[] | undefined;
  userIds?: string[] | undefined;
  dependsOn?: string[] | null | undefined;
}

// ─── User template ───

declare const USERTPL_ID_BRAND: unique symbol;
export type UserTplId = string & { readonly [USERTPL_ID_BRAND]: true };

export function generateUserTplId(): UserTplId {
  return `usertpl_${crypto.randomUUID()}` as UserTplId;
}

export interface UserTemplate {
  id: UserTplId;
  name: string;
  description?: string | undefined;
  /** UserGroup IDs to auto-join when a user is created with this template. */
  defaultGroupIds: string[];
  /** PermissionGroup IDs to auto-assign. */
  defaultPermGroupIds: string[];
  /** Other UserTemplate IDs to inherit from. */
  dependsOn: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateUserTplInput {
  name: string;
  description?: string | undefined;
  defaultGroupIds?: string[] | undefined;
  defaultPermGroupIds?: string[] | undefined;
  dependsOn?: string[] | undefined;
}

export interface UpdateUserTplInput {
  name?: string | undefined;
  description?: string | null | undefined;
  defaultGroupIds?: string[] | undefined;
  defaultPermGroupIds?: string[] | undefined;
  dependsOn?: string[] | null | undefined;
}

// ─── Comparison ───

export interface CompareResult {
  a: { id: string; name: string };
  b: { id: string; name: string };
  /** Items present in both. */
  common: Record<string, unknown>[];
  /** Items only in A. */
  onlyA: Record<string, unknown>[];
  /** Items only in B. */
  onlyB: Record<string, unknown>[];
  /** Dependency chain diff. */
  depDiff: {
    onlyA: string[];
    onlyB: string[];
    common: string[];
  };
}

// ─── Templates ───

export interface Template {
  id: string;
  name: string;
  description: string;
  rules: PermissionRule[];
}

// ─── Route ACL ───

declare const ROUTEACL_ID_BRAND: unique symbol;
export type RouteAclId = string & { readonly [ROUTEACL_ID_BRAND]: true };

export function generateRouteAclId(): RouteAclId {
  return `routeacl_${crypto.randomUUID()}` as RouteAclId;
}

export interface RouteAcl {
  id: RouteAclId;
  /** HTTP method (GET/POST/PUT/DELETE) or '*' for all. */
  method: string;
  /** URL path to match. With 'prefix' mode, matches anything starting with this. */
  pathPrefix: string;
  /** 'prefix' = starts-with match, 'exact' = full path match. Default 'prefix'. */
  matchType?: 'prefix' | 'exact' | undefined;
  /** 'allow' (default) or 'deny' — deny overrides. */
  effect?: 'allow' | 'deny' | undefined;
  /** Specific user this ACL applies to (optional). */
  userId?: string | undefined;
  /** User group this ACL applies to (optional). */
  userGroupId?: string | undefined;
  /** Higher priority evaluated first. */
  priority: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateRouteAclInput {
  method: string;
  pathPrefix: string;
  matchType?: 'prefix' | 'exact' | undefined;
  effect?: 'allow' | 'deny' | undefined;
  userId?: string | undefined;
  userGroupId?: string | undefined;
  priority?: number | undefined;
}

export interface UpdateRouteAclInput {
  method?: string | undefined;
  pathPrefix?: string | undefined;
  matchType?: 'prefix' | 'exact' | null | undefined;
  effect?: 'allow' | 'deny' | null | undefined;
  userId?: string | null | undefined;
  userGroupId?: string | null | undefined;
  priority?: number | undefined;
}

// ─── Permission check (existing) ───

export interface PermissionCheckInput {
  userId: string;
  action: string;
  resource: string;
  ip?: string | undefined;
  timestamp?: number | undefined;
  context?: Record<string, unknown> | undefined;
}

export interface PolicyMatchResult {
  allowed: boolean;
  reason: string;
  matchedPolicy?: StoredPolicy | undefined;
  /** Which permission group matched (if via group). */
  matchedGroup?: string | undefined;
}
