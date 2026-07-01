import type { IAtomicStore } from '../store/interfaces.ts';
import type { IAuditWriter, IAuditReader, IAuditAdmin, AuditEntry, StoredAuditEntry, LogQuery } from './types.ts';
import type { LogId } from '../brand.ts';
import { generateLogId } from '../brand.ts';
import { shouldLogAudit } from './log-policy.ts';
import { shouldPersist } from './persistence-policy.ts';
import { resolveFacility, encodePriority } from './kern-level.ts';
import { formatDmesgLine } from '../utils/dmesg.ts';
import { encodeCursor, decodeCursor, cursorFromEntry, xorHash } from './types.ts';
import { getBootId } from './context.ts';

const PFX_AUDIT = 'audit:ring:';
const IDX_AUDIT = 'audit:ring:ids';
const MAX_IN_MEMORY = 2000;
const MAX_KV_BATCH = 1000;

/** Strip _-prefixed keys to prevent trusted field forgery (journald convention). */
function sanitizeMetadata(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const cleaned: Record<string, unknown> = {};
  let hasKeys = false;
  for (const [k, v] of Object.entries(meta)) {
    if (!k.startsWith('_')) { cleaned[k] = v; hasKeys = true; }
  }
  return hasKeys ? cleaned : undefined;
}

export class HybridAuditLogger implements IAuditWriter, IAuditReader, IAuditAdmin {
  readonly #atomic: IAtomicStore | undefined;
  readonly #memory: StoredAuditEntry[] = [];
  readonly #maxInMemory: number;
  #seq = 0;
  readonly #bootId: string;
  readonly #machineHash: string;

  public constructor(atomic?: IAtomicStore, maxInMemory = MAX_IN_MEMORY) {
    this.#atomic = atomic;
    this.#maxInMemory = maxInMemory;
    // Derive machine hash from boot ID (stable within a process lifetime).
    this.#bootId = getBootId() ?? '00000000-0000-0000-0000-000000000000';
    this.#machineHash = hashBootId(this.#bootId);
  }

  public write(entry: AuditEntry): void {
    void this.#store(entry);
  }

  async #store(entry: AuditEntry): Promise<LogId> {
    const id = generateLogId();
    const now = Date.now();
    const facilityCode = resolveFacility(entry.facility);
    // Strip _-prefixed keys from metadata to prevent trusted field forgery (journald convention).
    const safeMeta = sanitizeMetadata(entry.metadata);
    // Generate journald-style cursor with tamper-detection xor_hash.
    const seq = ++this.#seq;
    const cursor = encodeCursor(cursorFromEntry(
      { id, timestamp: now } as unknown as StoredAuditEntry,
      this.#bootId,
      seq,
      this.#machineHash,
    ));
    const stored: StoredAuditEntry = {
      id, timestamp: now, priority: encodePriority(facilityCode, entry.level),
      level: entry.level, facility: entry.facility,
      message: entry.message, actorId: entry.actorId,
      cursor,
      ...(entry.trusted ? { trusted: entry.trusted } : {}),
      ...(safeMeta ? { metadata: safeMeta } : {}),
    };

    this.#memory.push(stored);
    if (this.#memory.length > this.#maxInMemory) this.#memory.shift();

    // Gate durable persistence with persistence policy (KV/DO costs real money).
    // Memory ring buffer and console output are free — always allowed.
    if (this.#atomic && shouldPersist(entry)) {
      try { await this.#persistToStore(stored); } catch {
        console.debug("noop");
      }
    }

    if (shouldLogAudit(entry.facility, entry.level)) {
      console.log(formatDmesgLine(entry.message, entry.actorId));
    }
    return id;
  }

  public async query(params?: LogQuery): Promise<{ entries: StoredAuditEntry[]; nextCursor?: string; total?: number }> {
    let all = this.#filterEntries(params);
    if (this.#atomic) {
      const fromKV = await this.#queryFromStore(params ?? {});
      const memIds = new Set(all.map(e => e.id));
      all = [...all, ...fromKV.filter(e => !memIds.has(e.id))].sort((a, b) => b.timestamp - a.timestamp);
    }
    // Apply afterCursor filter — skip entries up to and including the cursor position.
    if (params?.afterCursor) {
      const cursor = decodeCursor(params.afterCursor);
      if (cursor && this.#validateCursor(cursor)) {
        all = all.filter(e => {
          if (!e.cursor) return true; // entries without cursor pass through
          const ec = decodeCursor(e.cursor);
          return ec ? ec.i > cursor.i : true;
        });
      }
    }
    const total = all.length;
    if (params?.offset) all = all.slice(params.offset);
    if (params?.limit) all = all.slice(0, params.limit);
    // Return the cursor of the last entry as nextCursor for incremental consumption.
    const lastCursor: string | undefined = all.at(-1)?.cursor;
    return { entries: all, total, ...(lastCursor ? { nextCursor: lastCursor } : {}) };
  }

  /** Validate cursor integrity via xor_hash. Returns false if tampered. */
  #validateCursor(c: { s: string; i: number; b: string; m: number; t: number; x: string }): boolean {
    const expected = xorHash({ s: c.s, i: c.i, b: c.b, m: c.m, t: c.t });
    return c.x === expected;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface contract requires Promise<T>
  public async getById(id: LogId): Promise<StoredAuditEntry | null> {
    return this.#memory.find(e => e.id === id) ?? null;
  }

  public async queryAsync(params: LogQuery): Promise<{ entries: StoredAuditEntry[]; nextCursor?: string; total?: number }> {
    return this.query(params);
  }

  #filterEntries(params?: LogQuery): StoredAuditEntry[] {
    const { startTs, endTs } = params ?? {};
    let f = [...this.#memory];
    if (params?.facility) f = f.filter(e => e.facility === params.facility);
    if (startTs !== undefined) f = f.filter(e => e.timestamp >= startTs);
    if (endTs !== undefined) f = f.filter(e => e.timestamp <= endTs);
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
    const store = this.#atomic;
    const raw = await Promise.all(
      idx.value.map(id => store.get<StoredAuditEntry>(PFX_AUDIT + id)),
    );
    const entries: StoredAuditEntry[] = [];
    for (const r of raw) {
      if (r) entries.push(r.value);
    }
    let f = entries;
    if (params.facility) f = f.filter(e => e.facility === params.facility);
    if (params.startTs !== undefined) {
      const startTs = params.startTs;
      f = f.filter(e => e.timestamp >= startTs);
    }
    if (params.endTs !== undefined) {
      const endTs = params.endTs;
      f = f.filter(e => e.timestamp <= endTs);
    }
    return f;
  }

  // ─── IAuditAdmin ───


  public async prune(beforeTs: number): Promise<number> {
    // Filter in-memory
    const kept = this.#memory.filter(e => e.timestamp >= beforeTs);
    this.#memory.length = 0;
    this.#memory.push(...kept);
    // Filter KV
    if (this.#atomic) {
      const idx = await this.#atomic.get<string[]>(IDX_AUDIT);
      if (idx) {
        let removed = 0;
        for (const id of idx.value) {
          const entry = await this.#atomic.get<StoredAuditEntry>(PFX_AUDIT + id);
          if (entry && entry.value.timestamp < beforeTs) {
            await this.#atomic.set(PFX_AUDIT + id, null, entry.version);
            removed++;
          }
        }
        return removed;
      }
    }
    return 0;
  }

  public async pruneByIds(ids: readonly string[]): Promise<number> {
    const idSet = new Set(ids);
    const kept = this.#memory.filter(e => !idSet.has(e.id));
    this.#memory.length = 0;
    this.#memory.push(...kept);
    if (this.#atomic) {
      let removed = 0;
      for (const id of idSet) {
        const entry = await this.#atomic.get<StoredAuditEntry>(PFX_AUDIT + id);
        if (entry) {
          await this.#atomic.set(PFX_AUDIT + id, null, entry.version);
          removed++;
        }
      }
      return removed;
    }
    return 0;
  }
}

/** Derive a short machine hash from a boot UUID for cursor.s field. */
function hashBootId(bootId: string): string {
  let h = 0;
  for (let i = 0; i < bootId.length; i++) h ^= bootId.charCodeAt(i) << ((i % 4) * 8);
  return (h >>> 0).toString(16).padStart(8, '0');
}
