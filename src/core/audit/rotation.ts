/**
 * Log rotation — journald §9 model.
 *
 * Rotation policy mirrors journald configuration:
 *   SystemMaxUse       — max total storage (bytes)
 *   SystemMaxFileSize  — max per-file size (bytes)
 *   MaxRetentionSec    — max entry age (seconds)
 *
 * The prune() function selects entries to evict based on these limits.
 * Eviction priority: oldest entries first (journald behavior).
 */

import type { StoredAuditEntry } from './types.ts';

// ─── Configuration ───

export interface LogRotationConfig {
  /** Maximum total bytes used by all log entries. 0 = unlimited. */
  readonly maxTotalBytes: number;
  /** Maximum bytes per log file/shard. 0 = unlimited. */
  readonly maxFileBytes: number;
  /** Maximum age in milliseconds. 0 = unlimited. */
  readonly maxAgeMs: number;
  /** Minimum entries to keep regardless of limits. */
  readonly minEntries: number;
}

export const DEFAULT_ROTATION: LogRotationConfig = {
  maxTotalBytes: 100 * 1024 * 1024,  // 100 MB
  maxFileBytes: 16 * 1024 * 1024,   // 16 MB per shard
  maxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  minEntries: 1000,                   // keep at least 1000 entries
};

/** journald-style defaults for production. */
export const PRODUCTION_ROTATION: LogRotationConfig = {
  maxTotalBytes: 4 * 1024 * 1024 * 1024, // 4 GB (journald default cap)
  maxFileBytes: 512 * 1024 * 1024,       // 512 MB (SystemMaxUse / 8)
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,   // 30 days
  minEntries: 10000,
};

// ─── Prune logic ───

export interface PruneResult {
  readonly removed: number;
  readonly freedBytes: number;
  readonly remaining: number;
}

/**
 * Select entries to remove based on rotation policy.
 * Returns the IDs of entries to delete.
 * Entries are sorted oldest-first (journald behavior).
 */
export function selectEntriesToPrune(
  entries: readonly StoredAuditEntry[],
  config: LogRotationConfig,
): readonly string[] {
  if (entries.length <= config.minEntries) return [];

  // Sort by timestamp ascending (oldest first)
  const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);
  const toRemove: string[] = [];
  let totalSize: number;
  const now = Date.now();

  // Apply age-based eviction
  if (config.maxAgeMs > 0) {
    const cutoff = now - config.maxAgeMs;
    for (const entry of sorted) {
      if (toRemove.length + config.minEntries >= sorted.length) break;
      if (entry.timestamp < cutoff) {
        toRemove.push(entry.id);
      }
    }
  }

  // Remove already-marked entries from remaining
  const remainingAfterAge = sorted.filter(e => !toRemove.includes(e.id));
  totalSize = estimateTotalSize(remainingAfterAge);

  // Apply size-based eviction (oldest first)
  if (config.maxTotalBytes > 0 && totalSize > config.maxTotalBytes) {
    for (const entry of remainingAfterAge) {
      if (toRemove.length + config.minEntries >= sorted.length) break;
      if (totalSize <= config.maxTotalBytes) break;
      toRemove.push(entry.id);
      totalSize -= estimateEntrySize(entry);
    }
  }

  return toRemove;
}

/** Estimate the storage footprint of a single entry. */
export function estimateEntrySize(entry: StoredAuditEntry): number {
  // Rough estimate: JSON serialized size
  const textLen = entry.message?.length ?? 0;
  const metaLen = entry.metadata ? JSON.stringify(entry.metadata).length : 0;
  return textLen + metaLen + 200; // 200 bytes overhead
}

function estimateTotalSize(entries: readonly StoredAuditEntry[]): number {
  return entries.reduce((sum, e) => sum + estimateEntrySize(e), 0);
}

// ─── Prune via IAuditAdmin ───

import type { IAuditAdmin, IAuditReader } from './types.ts';

/**
 * Execute a prune pass on an audit backend.
 * Needs both IAuditReader (to list entries) and IAuditAdmin (to delete).
 */
export async function pruneBackend(
  reader: IAuditReader,
  admin: IAuditAdmin,
  config: LogRotationConfig = DEFAULT_ROTATION,
): Promise<PruneResult> {
  // Query all entries (with limit to avoid OOM)
  const allEntries: StoredAuditEntry[] = [];
  let cursor: string | undefined;
  const batchSize = 500;

  while (true) {
    const result = await reader.query({ limit: batchSize, ...(cursor ? { afterCursor: cursor } : {}) });
    allEntries.push(...(result.entries));
    if (!result.nextCursor || result.entries.length < batchSize) break;
    cursor = result.nextCursor;
  }

  const toRemove = selectEntriesToPrune(allEntries, config);

  if (toRemove.length > 0) {
    await admin.pruneByIds(toRemove);
  }

  return {
    removed: toRemove.length,
    freedBytes: toRemove.reduce((sum, id) => {
      const entry = allEntries.find(e => e.id === id);
      return sum + (entry ? estimateEntrySize(entry) : 0);
    }, 0),
    remaining: allEntries.length - toRemove.length,
  };
}
