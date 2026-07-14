import { z } from 'zod';

const NetworkRuleSchema = z.object({
  direction: z.enum(['ingress', 'egress']),
  protocol: z.enum(['tcp', 'udp']).optional(),
  port: z.number().optional(),
  cidr: z.string().optional(),
  action: z.enum(['allow', 'deny']),
  rateLimit: z.number().optional(),
});

const BandwidthControlSchema = z.object({
  egress: z.number().optional(),
  ingress: z.number().optional(),
  burst: z.number().optional(),
  priority: z.number().optional(),
});

export const SecurityGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  securityGroupId: z.string().optional(),
  rules: z.array(NetworkRuleSchema).readonly().optional(),
  bandwidth: BandwidthControlSchema.optional(),
  instanceId: z.string(),
  provider: z.string(),
  region: z.string(),
  providerNetworkId: z.string().optional(),
  visibility: z.enum(['public', 'private']),
  creatorId: z.string().optional(),
  userIds: z.array(z.string()).readonly().optional(),
  userGroupIds: z.array(z.string()).readonly().optional(),
  status: z.enum(['Active', 'Inactive', 'Error']),
  createdAt: z.number(),
  updatedAt: z.number(),
}).openapi({ ref: 'SecurityGroup' });
