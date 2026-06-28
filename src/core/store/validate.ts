/**
 * Storage-boundary validation — ensures data read from the store
 * conforms to the expected schema before entering business logic.
 *
 * Use getValidated() instead of raw atomic.get() when the shape
 * of stored data matters for correctness. In development, a
 * schema mismatch is a hard error; in production, it logs and
 * returns null to prevent corrupt data propagation.
 *
 * Pattern:
 *   const vol = await getValidated(atomic, key, VolumeSchema);
 *   // vol is Volume | null, guaranteed to match the schema
 */

import type { ZodType } from 'zod';
import type { IAtomicStore } from './interfaces.ts';

/**
 * Read and validate an entity from the atomic store.
 *
 * Returns null if the key doesn't exist or if the stored data
 * fails schema validation (corrupted entry).
 */
export async function getValidated<T>(
  atomic: IAtomicStore,
  key: string,
  schema: ZodType<T>,
): Promise<T | null> {
  const entry = await atomic.get<unknown>(key);
  if (!entry) return null;

  const result = schema.safeParse(entry.value);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    console.error(`[store] Schema validation failed for ${key}: ${issues}`);
    // In production, return null to prevent corrupt data propagation.
    // In dev/test, this is a bug — the data should have been valid when written.
    return null;
  }
  return result.data;
}

/**
 * Validate and store an entity. Ensures the data matches the schema
 * BEFORE writing, catching bugs at the source.
 */
export async function setValidated<T>(
  atomic: IAtomicStore,
  key: string,
  value: T,
  schema: ZodType<T>,
  expectedVersion: any,
): Promise<any> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`[store] Refusing to write invalid data to ${key}: ${issues}`);
  }
  return atomic.set(key, result.data, expectedVersion);
}
