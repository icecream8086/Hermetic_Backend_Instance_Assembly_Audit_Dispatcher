import { z } from 'zod';

const StoreMetricsSchema = z.object({
  gets: z.number(),
  hits: z.number(),
  misses: z.number(),
  sets: z.number(),
  hitRate: z.number(),
});

export const ServerInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string(),
  platform: z.string(),
  region: z.string().optional(),
  features: z.record(z.boolean()),
  uptime: z.number(),
  storeMetrics: StoreMetricsSchema,
});

export type ServerInfo = z.infer<typeof ServerInfoSchema>;
