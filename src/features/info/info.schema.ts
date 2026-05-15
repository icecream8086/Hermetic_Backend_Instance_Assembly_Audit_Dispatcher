import { z } from 'zod';

export const ServerInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string(),
  platform: z.string(),
  region: z.string().optional(),
  features: z.record(z.boolean()),
  uptime: z.number(),
});

export type ServerInfo = z.infer<typeof ServerInfoSchema>;
