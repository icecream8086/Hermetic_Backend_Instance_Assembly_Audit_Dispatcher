import type { IAtomicStore } from '../store/interfaces.ts';
import type { IAuditWriter, IAuditReader, AuditEntry, StoredAuditEntry, LogQuery } from './types.ts';
import type { LogId } from '../brand.ts';
import { generateLogId } from '../brand.ts';
import { shouldLogAudit } from './log-policy.ts';
import { resolveFacility, encodePriority } from './kern-level.ts';
import { formatDmesgLine } from '../utils/dmesg.ts';

const PFX_AUDIT = 'audit:ring:';
const IDX_AUDIT = 'audit:ring:ids';
const MAX_IN_MEMORY = 2000;
const MAX_KV_BATCH = 1000;

export class HybridAuditLogger implements IAuditWriter, IAuditReader {
  readonly #atomic: IAtomicStore | undefined;
  readonly #memory: StoredAuditEntry[] = [];
  readonly #maxInMemory: number;

  constructor(atomic?: IAtomicStore, maxInMemory = MAX_IN_MEMORY) {
    this.#atomic = atomic;
    this.#maxInMemory = maxInMemory;
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
    const stored: StoredAuditEntry = {
      id, timestamp: now, priority: encodePriority(facilityCode, entry.level),
      level: entry.level, facility: entry.facility,
      message: entry.message, actorId: entry.actorId,
      ...(entry.metadata ? { metadata: entry.metadata } : {}),
    };

    this.#memory.push(stored);
    if (this.#memory.length > this.#maxInMemory) this.#memory.shift();

    if (this.#atomic) {
      await this.#persistToStore(stored).catch(() => {});
    }

    if (shouldLogAudit(entry.facility, entry.level)) {
      console.log(formatDmesgLine(entry.message, entry.actorId));
    }
    return id;
  }

  async query(params?: LogQuery): Promise<{ entries: StoredAuditEntry[]; nextCursor?: string; total?: number }> {
    let f = this.#filterEntries(params);
    const total = f.length;
    if (params?.limit) f = f.slice(0, params.limit);
    return { entries: f, total };
  }

  async getById(id: LogId): Promise<StoredAuditEntry | null> {
    return this.#memory.find(e => e.id === id) ?? null;
  }

  async queryAsync(params: LogQuery): Promise<{ entries: StoredAuditEntry[]; nextCursor?: string; total?: number }> {
    let all = this.#filterEntries(params);
    if (this.#atomic) {
      const fromKV = await this.#queryFromStore(params);
      const memIds = new Set(all.map(e => e.id));
      all = [...all, ...fromKV.filter(e => !memIds.has(e.id))].sort((a, b) => b.timestamp - a.timestamp);
    }
    const total = all.length;
    if (params.limit) all = all.slice(0, params.limit);
    return { entries: all, total };
  }

  #filterEntries(params?: LogQuery): StoredAuditEntry[] {
    let f = [...this.#memory];
    if (params?.facility) f = f.filter(e => e.facility === params.facility);
    if (params?.startTs !== undefined) f = f.filter(e => e.timestamp >= params.startTs!);
    if (params?.endTs !== undefined) f = f.filter(e => e.timestamp <= params.endTs!);
    return f;
  }

  async #persistToStore(e: StoredAuditEntry): Promise<void> {
    if (!this.#atomic) return;
    const idx = await this.#atomic.get<string[]>(IDX_AUDIT);
    const ids = idx?.value ?? [];
    ids.push(e.id);
    if (ids.length > MAX_KV_BATCH) ids.shift();
    await this.#atomic.set(`${PFX_AUDIT}${e.id}`, e, null);
    await this.#atomic.set(IDX_AUDIT, ids, idx?.version ?? null);
  }

  async #queryFromStore(params: LogQuery): Promise<StoredAuditEntry[]> {
    if (!this.#atomic) return [];
    const idx = await this.#atomic.get<string[]>(IDX_AUDIT);
    if (!idx) return [];
    const entries = (await Promise.all(
      idx.value.map(id => this.#atomic!.get<StoredAuditEntry>(PFX_AUDIT + id)),
    )).filter(e => e).map(e => e!.value);
    let f = entries;
    if (params.facility) f = f.filter(e => e.facility === params.facility);
    if (params.startTs !== undefined) f = f.filter(e => e.timestamp >= params.startTs!);
    if (params.endTs !== undefined) f = f.filter(e => e.timestamp <= params.endTs!);
    return f;
  }
}
