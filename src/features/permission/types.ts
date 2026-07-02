import type { PolicyId, DenialLayer } from '../../core/permission/types.ts';
import { createPolicyId } from '../../core/permission/types.ts';

export { createPolicyId };
export type { PolicyId };

import { z } from 'zod';

const permissionIdSchema = z.string().min(1).brand('PermissionId');
export type PermissionId = z.infer<typeof permissionIdSchema>;

export function createPermissionId(raw: string): PermissionId {
  return permissionIdSchema.parse(raw);
}

export function generatePermissionId(): PermissionId {
  return permissionIdSchema.parse(`perm_${crypto.randomUUID()}`);
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

const userGroupIdSchema = z.string().min(1).brand('UserGroupId');
export type UserGroupId = z.infer<typeof userGroupIdSchema>;

export function generateUserGroupId(): UserGroupId {
  return userGroupIdSchema.parse(`usergrp_${crypto.randomUUID()}`);
}

export interface UserGroup {
  id: UserGroupId;
  name: string;
  description?: string | undefined;
  memberIds: string[];
  /** User IDs who can administer this group (invite, remove members). Creator is first admin. */
  adminIds: string[];
  dependsOn: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateUserGroupInput {
  name: string;
  description?: string | undefined;
  memberIds?: string[] | undefined;
  adminIds?: string[] | undefined;
  dependsOn?: string[] | undefined;
}

export interface UpdateUserGroupInput {
  name?: string | undefined;
  description?: string | null | undefined;
  memberIds?: string[] | undefined;
  adminIds?: string[] | undefined;
  dependsOn?: string[] | null | undefined;
}

// ─── Permission rule (within a permission group) ───

export interface PermissionRule {
  effect: PolicyEffect;
  actions: string[];
  resource?: string | undefined;
  priority: number;
  description?: string | undefined;
}

// ─── Permission group ───

const permGroupIdSchema = z.string().min(1).brand('PermGroupId');
export type PermGroupId = z.infer<typeof permGroupIdSchema>;

export function generatePermGroupId(): PermGroupId {
  return permGroupIdSchema.parse(`permgrp_${crypto.randomUUID()}`);
}

export interface PermissionGroup {
  id: PermGroupId;
  name: string;
  description?: string | undefined;
  rules: PermissionRule[];
  userGroupIds: string[];
  userIds: string[];
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

const userTplIdSchema = z.string().min(1).brand('UserTplId');
export type UserTplId = z.infer<typeof userTplIdSchema>;

export function generateUserTplId(): UserTplId {
  return userTplIdSchema.parse(`usertpl_${crypto.randomUUID()}`);
}

export interface UserTemplate {
  id: UserTplId;
  name: string;
  description?: string | undefined;
  defaultGroupIds: string[];
  defaultPermGroupIds: string[];
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

// ─── Log policy ───

export interface LogPolicyEntry {
  readonly facility: string;
  readonly level: string;        // 'debug' | 'info' | 'warn' | 'error' | 'none'
}

export interface LogPolicy {
  readonly defaultLevel: string;
  readonly auditLevel: string;
  readonly facilities: LogPolicyEntry[];
  readonly updatedAt: number;
  readonly updatedBy?: string | undefined;
}

// ─── Templates ───

export interface Template {
  id: string;
  name: string;
  description: string;
  rules: PermissionRule[];
}

// ─── Route ACL ───

const routeAclIdSchema = z.string().min(1).brand('RouteAclId');
export type RouteAclId = z.infer<typeof routeAclIdSchema>;

export function generateRouteAclId(): RouteAclId {
  return routeAclIdSchema.parse(`routeacl_${crypto.randomUUID()}`);
}

export interface RouteAcl {
  id: RouteAclId;
  method: string;
  pathPrefix: string;
  matchType?: 'prefix' | 'exact' | 'regex' | undefined;
  effect?: 'allow' | 'deny' | undefined;
  userId?: string | undefined;
  userGroupId?: string | undefined;
  priority: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateRouteAclInput {
  method: string;
  pathPrefix: string;
  matchType?: 'prefix' | 'exact' | 'regex' | undefined;
  effect?: 'allow' | 'deny' | undefined;
  userId?: string | undefined;
  userGroupId?: string | undefined;
  priority?: number | undefined;
}

export interface UpdateRouteAclInput {
  method?: string | undefined;
  pathPrefix?: string | undefined;
  matchType?: 'prefix' | 'exact' | 'regex' | null | undefined;
  effect?: 'allow' | 'deny' | null | undefined;
  userId?: string | null | undefined;
  userGroupId?: string | null | undefined;
  priority?: number | undefined;
}

// ─── Invitation ───

export const INVITE_PREFIX = 'invite:';
export const INVITE_INDEX_KEY = 'invite:ids';
export const INVITE_PENDING_KEY = 'invite:pending:';

export type InviteStatus = 'pending' | 'accepted' | 'rejected';

export interface Invitation {
  id: string;
  /** Target user group ID. */
  groupId: string;
  /** User being invited. */
  inviteeId: string;
  /** User who sent the invitation. */
  invitedBy: string;
  status: InviteStatus;
  createdAt: number;
  expiresAt: number;
}

export interface CreateInviteInput {
  groupId: string;
  inviteeId: string;
}

// ─── Comparison ───

export interface CompareResult {
  a: { id: string; name: string };
  b: { id: string; name: string };
  common: Record<string, unknown>[];
  onlyA: Record<string, unknown>[];
  onlyB: Record<string, unknown>[];
  depDiff: {
    onlyA: string[];
    onlyB: string[];
    common: string[];
  };
}

// ─── Permission check (existing) ───

export interface PermissionCheckInput {
  userId: string;
  action: string;
  resource: string;
  ip?: string | undefined;
  timestamp?: number | undefined;
  context?: Record<string, unknown> | undefined;
  /** If set, the resource is owned by this user ID. Rules with `resource:$self`
   *  match when the acting user === the resource owner. */
  resourceOwnerId?: string | undefined;
}

export interface PolicyMatchResult {
  allowed: boolean;
  reason: string;
  matchedPolicy?: StoredPolicy | undefined;
  matchedGroup?: string | undefined;
  /** Which denial layer. Undefined if allowed. */
  layer?: DenialLayer;
  /** Audit type for denial events. */
  auditType?: string;
}
