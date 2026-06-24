import type { IAtomicStore } from '../store/interfaces.ts';
import type { IAuditWriter, IAuditReader, IAuditAdmin, AuditEntry, StoredAuditEntry, LogQuery } from './types.ts';
import type { LogId } from '../brand.ts';
import { generateLogId } from '../brand.ts';
import { resolveFacility, encodePriority } from './kern-level.ts';

const AUDIT_TTL_SEC = 7 * 24 * 60 * 60;
const AUDIT_PREFIX = 'audit:';
const MAX_INDEX_ENTRIES = 10_000;

export class KvAuditLogger implements IAuditWriter, IAuditReader, IAuditAdmin {
  readonly #entries: StoredAuditEntry[] = [];
  readonly #capacity: number;

  constructor(
    private readonly atomic: IAtomicStore,
    capacity = MAX_INDEX_ENTRIES,
  ) {
    this.#capacity = capacity;
  }

  async write(entry: AuditEntry): Promise<void> {
    await this.#store(entry);
  }

  async writeSync(entry: AuditEntry): Promise<LogId> {
    return this.#store(entry);
  }

  async #store(entry: AuditEntry): Promise<LogId> {
    const id = generateLogId();
    const now = Date.now();
    const facilityCode = resolveFacility(entry.facility);

    await this.atomic.set(AUDIT_PREFIX + id, entry, null, AUDIT_TTL_SEC);

    const stored: StoredAuditEntry = {
      id, timestamp: now, priority: encodePriority(facilityCode, entry.level),
      level: entry.level, facility: entry.facility,
      message: entry.message, actorId: entry.actorId,
      ...(entry.metadata ? { metadata: entry.metadata } : {}),
    };
    this.#entries.push(stored);
    if (this.#entries.length > this.#capacity) this.#entries.shift();
    return id;
  }

  async query(params?: LogQuery): Promise<{ entries: StoredAuditEntry[]; nextCursor?: string; total?: number }> {
    let f = [...this.#entries];
    if (params?.facility) f = f.filter(e => e.facility === params.facility);
    if (params?.startTs !== undefined) f = f.filter(e => e.timestamp >= params.startTs!);
    if (params?.endTs !== undefined) f = f.filter(e => e.timestamp <= params.endTs!);
    const total = f.length;
    if (params?.limit) f = f.slice(0, params.limit);
    return { entries: f, total };
  }

  async getById(id: LogId): Promise<StoredAuditEntry | null> {
    return this.#entries.find(e => e.id === id) ?? null;
  }

  // ─── IAuditAdmin ───
  async forceSetTail(_facility: any, _tailId: any): Promise<void> {}



  async prune(beforeTs: number): Promise<number> {
    const idx = await this.atomic.get<string[]>(AUDIT_PREFIX + 'ids');
    if (!idx) return 0;
    let removed = 0;
    const kept: string[] = [];
    for (const id of idx.value) {
      const entry = await this.atomic.get<StoredAuditEntry>(AUDIT_PREFIX + id);
      if (entry && entry.value.timestamp < beforeTs) {
        await this.atomic.set(AUDIT_PREFIX + id, null, entry.version);
        removed++;
      } else {
        kept.push(id);
      }
    }
    if (removed > 0) await this.atomic.set(AUDIT_PREFIX + 'ids', kept, idx.version);
    return removed;
  }

  async pruneByIds(ids: readonly string[]): Promise<number> {
    const idx = await this.atomic.get<string[]>(AUDIT_PREFIX + 'ids');
    if (!idx) return 0;
    let removed = 0;
    const idSet = new Set(ids);
    for (const id of idSet) {
      const entry = await this.atomic.get<StoredAuditEntry>(AUDIT_PREFIX + id);
      if (entry) {
        await this.atomic.set(AUDIT_PREFIX + id, null, entry.version);
        removed++;
      }
    }
    if (removed > 0) {
      await this.atomic.set(AUDIT_PREFIX + 'ids', idx.value.filter(i => !idSet.has(i)), idx.version);
    }
    return removed;
  }
}
