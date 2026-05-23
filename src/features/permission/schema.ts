import { z } from 'zod';

export const PolicyEffectSchema = z.enum(['allow', 'deny']);

// ─── Individual policy (existing) ───

export const CreatePolicySchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  description: z.string().max(500).optional(),
  effect: PolicyEffectSchema,
  userId: z.string().uuid().optional(),
  role: z.string().max(100).optional(),
  actions: z.array(z.string().min(1)).optional().default([]),
  resource: z.string().max(200).optional(),
  priority: z.number().int().optional().default(0),
});

export const UpdatePolicySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional(),
  effect: PolicyEffectSchema.optional(),
  userId: z.string().uuid().optional().nullable(),
  role: z.string().max(100).optional().nullable(),
  actions: z.array(z.string().min(1)).optional(),
  resource: z.string().max(200).optional().nullable(),
  priority: z.number().int().optional(),
  enabled: z.boolean().optional(),
});

// ─── User group ───

export const CreateUserGroupSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  description: z.string().max(500).optional(),
  memberIds: z.array(z.string()).optional().default([]),
  dependsOn: z.array(z.string()).optional().default([]),
});

export const UpdateUserGroupSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional().nullable(),
  memberIds: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).optional().nullable(),
});

// ─── Permission rule ───

export const PermissionRuleSchema = z.object({
  effect: PolicyEffectSchema,
  actions: z.array(z.string().min(1)).default([]),
  resource: z.string().max(200).optional(),
  priority: z.number().int().optional().default(0),
});

// ─── Permission group ───

export const CreatePermGroupSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  description: z.string().max(500).optional(),
  rules: z.array(PermissionRuleSchema).default([]),
  userGroupIds: z.array(z.string()).optional().default([]),
  userIds: z.array(z.string()).optional().default([]),
  dependsOn: z.array(z.string()).optional().default([]),
});

export const UpdatePermGroupSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional().nullable(),
  rules: z.array(PermissionRuleSchema).optional(),
  userGroupIds: z.array(z.string()).optional(),
  userIds: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).optional().nullable(),
});

// ─── User template ───

export const CreateUserTplSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  description: z.string().max(500).optional(),
  defaultGroupIds: z.array(z.string()).optional().default([]),
  defaultPermGroupIds: z.array(z.string()).optional().default([]),
  dependsOn: z.array(z.string()).optional().default([]),
});

export const UpdateUserTplSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional().nullable(),
  defaultGroupIds: z.array(z.string()).optional(),
  defaultPermGroupIds: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).optional().nullable(),
});

// ─── Route ACL ───

export const MatchTypeSchema = z.enum(['prefix', 'exact']);
export const AclEffectSchema = z.enum(['allow', 'deny']);

export const CreateRouteAclSchema = z.object({
  method: z.string().min(1, 'Method is required').max(10),
  pathPrefix: z.string().min(1, 'Path prefix is required').max(500),
  matchType: MatchTypeSchema.optional().default('prefix'),
  effect: AclEffectSchema.optional().default('allow'),
  userId: z.string().uuid().optional(),
  userGroupId: z.string().optional(),
  priority: z.number().int().optional().default(0),
});

export const UpdateRouteAclSchema = z.object({
  method: z.string().min(1).max(10).optional(),
  pathPrefix: z.string().min(1).max(500).optional(),
  matchType: MatchTypeSchema.optional().nullable(),
  effect: AclEffectSchema.optional().nullable(),
  userId: z.string().uuid().optional().nullable(),
  userGroupId: z.string().optional().nullable(),
  priority: z.number().int().optional(),
});

// ─── Permission check (existing) ───

export const PermissionCheckSchema = z.object({
  userId: z.string(),
  action: z.string().min(1),
  resource: z.string().min(1),
  ip: z.string().optional(),
  timestamp: z.number().optional(),
  context: z.record(z.unknown()).optional(),
});
