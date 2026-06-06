import type { IAuditWriter, IAuditReader, AuditEntry, AuditFilter, AuditQueryResult, StoredAuditEntry } from './types.ts';
import { generateLogId } from '../brand.ts';
import { shouldLogAudit } from '../logger/log-policy.ts';
import { formatDmesgLine } from '../utils/dmesg.ts';

const MAX_ENTRIES = 2000;

/** Format a stored entry as JSON string (matching Workers Logs output). */
function formatEntry(e: StoredAuditEntry): string {
  const actorId = e.actorId ?? (e.metadata?.actorId as string | undefined);
  return JSON.stringify({
    id: e.id, timestamp: e.timestamp, message: e.message,
    facility: e.facility, level: e.level,
    ...(actorId ? { actorId } : {}),
    ...(e.metadata ? { metadata: e.metadata } : {}),
  });
}

/**
 * Local dev audit logger — simulates Cloudflare Logs.
 * Stores entries in a ring buffer, serves via audit API in the same
 * format as WorkersAuditLogger, so log filtering/policy management
 * works identically during development.
 */
export class LocalAuditLogger implements IAuditWriter, IAuditReader {
  readonly #entries: StoredAuditEntry[] = [];
  readonly #capacity: number;

  constructor(capacity = MAX_ENTRIES) {
    this.#capacity = capacity;
  }

  async write(entry: AuditEntry): Promise<void> {
    const now = Date.now();
    const stored: StoredAuditEntry = {
      id: generateLogId(), timestamp: now,
      level: entry.level, facility: entry.facility,
      message: entry.message, actorId: entry.actorId,
      ...(entry.metadata ? { metadata: entry.metadata } : {}),
    };
    this.#entries.push(stored);
    if (this.#entries.length > this.#capacity) this.#entries.shift();

    if (shouldLogAudit(entry.facility, entry.level)) {
      console.log(formatDmesgLine(entry.message, entry.actorId));
    }
  }

  query(filter?: AuditFilter): AuditQueryResult {
    const page = filter?.page ?? 1;
    const limit = filter?.limit ?? 50;
    let f = [...this.#entries];
    if (filter?.facility) f = f.filter(e => e.facility === filter.facility);
    if (filter?.levelMin !== undefined) f = f.filter(e => e.level <= filter.levelMin!);
    if (filter?.levelMax !== undefined) f = f.filter(e => e.level >= filter.levelMax!);
    if (filter?.since) f = f.filter(e => e.timestamp >= filter.since!);
    if (filter?.until) f = f.filter(e => e.timestamp <= filter.until!);
    if (filter?.search) { const q = filter.search.toLowerCase(); f = f.filter(e => e.message.toLowerCase().includes(q)); }
    const total = f.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const offset = (page - 1) * limit;
    return { lines: f.slice(offset, offset + limit).map(e => formatEntry(e)), total, page, limit, totalPages };
  }

  stats(): { count: number; capacity: number } {
    return { count: this.#entries.length, capacity: this.#capacity };
  }

  async tail(): Promise<void> { /* no-op in local dev */ }
}
