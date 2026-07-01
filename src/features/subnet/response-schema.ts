import { z } from 'zod';

export const SubnetSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  cidr: z.string(),
  subnetPrefix: z.number(),
  instanceId: z.string(),
  provider: z.string(),
  region: z.string(),
  providerSubnetId: z.string().optional(),
  visibility: z.enum(['public', 'private']),
  creatorId: z.string().optional(),
  userIds: z.array(z.string()).readonly().optional(),
  userGroupIds: z.array(z.string()).readonly().optional(),
  status: z.enum(['Active', 'Inactive', 'Full', 'Error']),
  createdAt: z.number(),
  updatedAt: z.number(),
});
