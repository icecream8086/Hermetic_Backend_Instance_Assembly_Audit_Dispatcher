import { z } from 'zod';

export const PermissionRuleSchema = z.object({
  effect: z.enum(['allow', 'deny']),
  actions: z.array(z.string()).readonly(),
  resource: z.string().optional(),
  priority: z.number(),
  description: z.string().optional(),
}).openapi('PermissionRule');

export const TemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  rules: z.array(PermissionRuleSchema).readonly(),
}).openapi('PermissionTemplate');

export const InvitationSchema = z.object({
  id: z.string(),
  groupId: z.string(),
  inviteeId: z.string(),
  invitedBy: z.string(),
  status: z.enum(['pending', 'accepted', 'rejected']),
  createdAt: z.number(),
  expiresAt: z.number(),
});

export const LogPolicySchema = z.object({
  defaultLevel: z.string(),
  auditLevel: z.string(),
  facilities: z.array(z.object({
    facility: z.string(),
    level: z.string(),
  })),
  updatedAt: z.number(),
  updatedBy: z.string().optional(),
  exists: z.boolean(),
});

export const UserCapsSchema = z.object({
  userId: z.string(),
  caps: z.number(),
});

export const UserCapsResultSchema = z.object({
  own: z.number(),
  caps: z.array(z.string()).readonly(),
});

export const GroupCapsSchema = z.object({
  groupId: z.string(),
  caps: z.number(),
});

export const GroupCapsResultSchema = z.object({
  caps: z.number(),
  names: z.array(z.string()).readonly(),
});

export const ElevationGrantSchema = z.object({
  userId: z.string(),
  expiry: z.number(),
  capabilities: z.number().optional(),
});

export const ElevationEntrySchema = z.object({
  userId: z.string(),
  expiry: z.number(),
  caps: z.number(),
  capsNames: z.array(z.string()).readonly(),
});

export const CompareResultSchema = z.object({
  a: z.object({ id: z.string(), name: z.string() }),
  b: z.object({ id: z.string(), name: z.string() }),
  common: z.array(z.record(z.string(), z.unknown())).readonly(),
  onlyA: z.array(z.record(z.string(), z.unknown())).readonly(),
  onlyB: z.array(z.record(z.string(), z.unknown())).readonly(),
  depDiff: z.object({
    onlyA: z.array(z.string()).readonly(),
    onlyB: z.array(z.string()).readonly(),
    common: z.array(z.string()).readonly(),
  }),
});

const StoredPolicySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  effect: z.enum(['allow', 'deny']),
  userId: z.string().optional(),
  role: z.string().optional(),
  actions: z.array(z.string()).readonly(),
  resource: z.string().optional(),
  priority: z.number(),
  enabled: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const PolicyMatchResultSchema = z.object({
  allowed: z.boolean(),
  reason: z.string(),
  matchedPolicy: StoredPolicySchema.optional(),
  matchedGroup: z.string().optional(),
  layer: z.enum(['dac', 'cap', 'mac']).optional(),
  auditType: z.string().optional(),
});
