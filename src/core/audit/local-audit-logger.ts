import type { IAuditWriter, IAuditReader, IAuditAdmin, AuditEntry, StoredAuditEntry, LogQuery } from './types.ts';
import type { LogId } from '../brand.ts';
import { generateLogId } from '../brand.ts';
import { shouldLogAudit } from './log-policy.ts';
import { resolveFacility, encodePriority } from './kern-level.ts';
import { formatDmesgLine } from '../utils/dmesg.ts';

const MAX_ENTRIES = 2000;

export class LocalAuditLogger implements IAuditWriter, IAuditReader, IAuditAdmin {
  readonly #entries: StoredAuditEntry[] = [];
  readonly #capacity: number;

  public constructor(capacity = MAX_ENTRIES) {
    this.#capacity = capacity;
  }

  public async write(entry: AuditEntry): Promise<void> {
    await this.#store(entry);
  }

  public async writeSync(entry: AuditEntry): Promise<LogId> {
    return this.#store(entry);
  }

  public async #store(entry: AuditEntry): Promise<LogId> {
    const id = generateLogId();
    const now = Date.now();
    const facilityCode = resolveFacility(entry.facility);
    const stored: StoredAuditEntry = {
      id, timestamp: now, priority: encodePriority(facilityCode, entry.level),
      level: entry.level, facility: entry.facility,
      message: entry.message, actorId: entry.actorId,
      ...(entry.metadata ? { metadata: entry.metadata } : {}),
    };
    this.#entries.push(stored);
    if (this.#entries.length > this.#capacity) this.#entries.shift();

    if (shouldLogAudit(entry.facility, entry.level)) {
      console.log(formatDmesgLine(entry.message, entry.actorId));
    }
    return id;
  }

  public async query(params?: LogQuery): Promise<{ entries: StoredAuditEntry[]; nextCursor?: string; total?: number }> {
    let f = [...this.#entries];
    if (params?.facility) f = f.filter(e => e.facility === params.facility);
    if (params?.startTs !== undefined) f = f.filter(e => e.timestamp >= params.startTs!);
    if (params?.endTs !== undefined) f = f.filter(e => e.timestamp <= params.endTs!);
    const total = f.length;
    if (params?.limit) f = f.slice(0, params.limit);
    return { entries: f, total };
  }

  public async getById(id: LogId): Promise<StoredAuditEntry | null> {
    return this.#entries.find(e => e.id === id) ?? null;
  }

  public stats(): { count: number; capacity: number } {
    return { count: this.#entries.length, capacity: this.#capacity };
  }

  // ─── IAuditAdmin ───
  public async forceSetTail(_facility: any, _tailId: any): Promise<void> {}



  public async prune(beforeTs: number): Promise<number> {
    const kept = this.#entries.filter(e => e.timestamp >= beforeTs);
    const removed = this.#entries.length - kept.length;
    this.#entries.length = 0;
    this.#entries.push(...kept);
    return removed;
  }

  public async pruneByIds(ids: readonly string[]): Promise<number> {
    const idSet = new Set(ids);
    const before = this.#entries.length;
    const kept = this.#entries.filter(e => !idSet.has(e.id));
    this.#entries.length = 0;
    this.#entries.push(...kept);
    return before - kept.length;
  }
}
