import type { Pool } from '../dag/types.ts';

/**
 * Pool manager — slot-based concurrency control (Airflow Pool model).
 *
 * Each pool has a fixed number of `slots`. Tasks that declare `pool: "name"`
 * consume one slot while RUNNING. When no open slots remain, excess tasks
 * are starved until a slot is released.
 */

// ─── Factory ───

export function createPool(name: string, slots: number, description?: string): Pool {
  if (slots < 1) throw new RangeError(`Pool "${name}" must have at least 1 slot`);
  return { name, slots, occupiedSlots: 0, description: description ?? undefined };
}

// ─── Slot operations ───

export function openSlots(pool: Pool): number {
  return Math.max(0, pool.slots - pool.occupiedSlots);
}

export function hasOpenSlots(pool: Pool): boolean {
  return pool.occupiedSlots < pool.slots;
}

/** Try to claim a slot. Returns the updated pool or null if pool is full. */
export function claimSlot(pool: Pool): Pool | null {
  if (!hasOpenSlots(pool)) return null;
  return { ...pool, occupiedSlots: pool.occupiedSlots + 1 };
}

/** Release a slot. Idempotent — won't go below 0. */
export function releaseSlot(pool: Pool): Pool {
  return { ...pool, occupiedSlots: Math.max(0, pool.occupiedSlots - 1) };
}

// ─── Default pool (always available, unlimited slots) ───

export const DEFAULT_POOL_NAME = 'default_pool';

/**
 * The default pool has a very high slot count, effectively unlimited.
 * Real concurrency is enforced by the executor parallelism slot, not the pool.
 */
export const DEFAULT_POOL: Pool = createPool(DEFAULT_POOL_NAME, 128, 'Default pool');
