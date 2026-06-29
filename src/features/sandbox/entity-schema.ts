/**
 * Zod schema for Sandbox entity — storage-boundary validator.
 *
 * This is intentionally a "loose" schema: it validates the core invariants
 * (status is a known value, critical fields are present) while allowing
 * the full nested config shape to vary by API version (v1 vs v2).
 *
 * Purpose: catch storage corruption (e.g. a bad status string) at read time,
 * rather than letting it propagate silently into business logic.
 */

import { z } from 'zod';
import { SandboxStatus } from './types.ts';

// ─── Core identity fields ───

const TagSchema = z.object({
  key: z.string(),
  value: z.string(),
});

const BaseFields = {
  id: z.string().min(1),
  name: z.string(),
  description: z.string().optional(),
  tags: z.array(TagSchema).default([]),
  createdAt: z.number(),
  updatedAt: z.number(),
  version: z.string(),
};

// ─── Sandbox entity schema ───

export const SandboxSchema = z.object({
  ...BaseFields,
  status: z.enum(SandboxStatus),
  config: z.record(z.string(), z.unknown()).default({}),
  podUid: z.string().optional(),
  providerId: z.string().optional(),
  network: z.record(z.string(), z.unknown()).default({}),
  containers: z.array(z.record(z.string(), z.unknown())).default([]),
  conditions: z.array(z.record(z.string(), z.unknown())).optional(),
  events: z.array(z.record(z.string(), z.unknown())).default([]),
  ephemeralStorageGiB: z.number().optional(),
}).passthrough(); // allow unrecognized fields for forward compatibility
// TODO: Zod v4 — use z.looseObject() once the full migration settles

/** Entity type derived from the schema. */
export type Sandbox = z.infer<typeof SandboxSchema>;
