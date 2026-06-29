/**
 * R2-backed audit logger — production persistence for Cloudflare Workers.
 *
 * Write path:
 *   entry → shouldPersist() gate → buffer → batch flush to R2 (every 5s or 100 entries)
 *                           ↘ console.log → Workers Logs (free, Logpush-able)
 *
 * journald §9 persistent storage model:
 *   Tier 2 (durable) — ERR/CRIT/ALERT/EMERG → R2
 *   Tier 3 (immutable) — auth/perm WARNING+ → R2
 *   Tier 0 (console) — all levels → Workers Logs (free backup)
 */

import type { IAuditWriter, IAuditReader, IAuditAdmin, AuditEntry, StoredAuditEntry, LogQuery } from './types.ts';
import type { LogId } from '../brand.ts';
import { generateLogId } from '../brand.ts';
import { KernLevel, kernLevelName, resolveFacility, encodePriority } from './kern-level.ts';
import { shouldLogAudit } from './log-policy.ts';
import { shouldPersist } from './persistence-policy.ts';
import { encodeCursor, decodeCursor, cursorFromEntry, xorHash } from './types.ts';
import { getBootId } from './context.ts';

// ─── R2 abstraction ───

export interface R2Bucket {
  put(key: string, value: string | ArrayBuffer | Uint8Array): Promise<void>;
  get(key: string): Promise<{ body: ArrayBuffer; key: string } | null>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    objects: { key: string; size: number; uploaded: Date }[];
    cursor?: string;
    truncated: boolean;
  }>;
  delete(key: string | string[]): Promise<void>;
}

// ─── Config ───

export interface R2LoggerConfig {
  /** Key prefix for log objects. */
  prefix: string;
  /** Max log entries per R2 object (batch writes). */
  batchSize: number;
  /** Flush interval in ms. */
  flushIntervalMs: number;
}

const DEFAULT_CONFIG: R2LoggerConfig = {
  prefix: 'audit-logs/',
  batchSize: 100,
  flushIntervalMs: 5000,
};

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

// ─── R2 Audit Logger ───

export class R2AuditLogger implements IAuditWriter, IAuditReader, IAuditAdmin {
  readonly #buffer: StoredAuditEntry[] = [];
  readonly #config: R2LoggerConfig;
  #flushTimer: ReturnType<typeof setInterval> | null = null;
  #seq = 0;
  readonly #bootId: string;
  readonly #machineHash: string;

  public constructor(
    private readonly bucket: R2Bucket,
    config: Partial<R2LoggerConfig> = {},
  ) {
    this.#config = { ...DEFAULT_CONFIG, ...config };
    this.#bootId = getBootId() ?? '00000000-0000-0000-0000-000000000000';
    this.#machineHash = hashBootId(this.#bootId);
  }

  // ─── IAuditWriter ───

  public write(entry: AuditEntry): void {
    void this.#process(entry);
  }

  async #process(entry: AuditEntry): Promise<LogId> {
    const id = generateLogId();
    const now = Date.now();
    const facility = entry.facility ?? 'audit';
    const facilityCode = resolveFacility(facility);

    // Strip _-prefixed keys from metadata to prevent trusted field forgery (journald convention).
    const safeMeta = sanitizeMetadata(entry.metadata);

    // Generate journald-style cursor with tamper-detection xor_hash.
    const seq = ++this.#seq;
    const cursor = encodeCursor(cursorFromEntry(
      { id, timestamp: now } as unknown as StoredAuditEntry,
      this.#bootId, seq, this.#machineHash,
    ));

    const stored: StoredAuditEntry = {
      id, timestamp: now,
      priority: encodePriority(facilityCode, entry.level),
      level: entry.level, facility,
      message: entry.message,
      actorId: entry.actorId,
      cursor,
      ...(entry.trusted ? { trusted: entry.trusted } : {}),
      ...(safeMeta ? { metadata: safeMeta } : {}),
    };

    // Gate expensive R2 writes with persistence policy.
    if (shouldPersist(entry)) {
      this.#buffer.push(stored);
      if (this.#buffer.length >= this.#config.batchSize) {
        await this.flush().catch(() => { /* noop */ });
      }
    }

    // Always write to console — Workers Logs is free, acts as backup via Logpush.
    if (shouldLogAudit(facility, entry.level)) {
      this.#consoleOut(entry, stored);
    }

    return id;
  }

  #consoleOut(entry: AuditEntry, stored: StoredAuditEntry): void {
    const ts = new Date(stored.timestamp).toISOString();
    const levelName = kernLevelName(entry.level);
    const facility = entry.facility ?? 'audit';
    const line = `[${ts}] ${levelName}: [${facility}] ${entry.message}`;
    const meta = stored.metadata ? JSON.stringify(stored.metadata) : undefined;

    if (entry.level <= KernLevel.ERR) {
      if (meta) { console.error(line, meta); } else { console.error(line); }
    } else if (entry.level === KernLevel.WARNING) {
      if (meta) { console.warn(line, meta); } else { console.warn(line); }
    } else {
      if (meta) { console.log(line, meta); } else { console.log(line); }
    }
  }

  // ─── Flush ───

  public async flush(): Promise<void> {
    if (this.#buffer.length === 0) return;
    const batch = this.#buffer.splice(0);
    const now = Date.now();
    const key = `${this.#config.prefix}${String(now)}-${batch[0]!.id}.json`;
    await this.bucket.put(key, JSON.stringify(batch));
  }

  // ─── IAuditReader ───

  public async query(params?: LogQuery): Promise<{ entries: StoredAuditEntry[]; nextCursor?: string; total?: number }> {
    const limit = params?.limit ?? 100;
    const prefix = this.#config.prefix;
    const listResult = await this.bucket.list({
      prefix,
      limit: Math.ceil(limit / this.#config.batchSize),
      ...(params?.afterCursor ? { cursor: params.afterCursor } : {}),
    });

    const entries: StoredAuditEntry[] = [];
    for (const obj of listResult.objects) {
      const data = await this.bucket.get(obj.key);
      if (!data) continue;
      try {
        const batch: StoredAuditEntry[] = JSON.parse(new TextDecoder().decode(data.body));
        let filtered = batch;
        if (params?.facility) filtered = filtered.filter(e => e.facility === params.facility);
        if (params?.startTs !== undefined) filtered = filtered.filter(e => e.timestamp >= params.startTs!);
        if (params?.endTs !== undefined) filtered = filtered.filter(e => e.timestamp <= params.endTs!);
        entries.push(...filtered);
      } catch { /* skip corrupt files */ }
      if (entries.length >= limit) break;
    }

    // Include unflushed buffer entries that might be relevant
    if (this.#buffer.length > 0) {
      let buf = [...this.#buffer];
      if (params?.facility) buf = buf.filter(e => e.facility === params.facility);
      if (params?.startTs !== undefined) buf = buf.filter(e => e.timestamp >= params.startTs!);
      if (params?.endTs !== undefined) buf = buf.filter(e => e.timestamp <= params.endTs!);
      entries.push(...buf);
    }

    // Apply afterCursor filter with tamper validation.
    if (params?.afterCursor) {
      const cursor = decodeCursor(params.afterCursor);
      if (cursor && this.#validateCursor(cursor)) {
        const filtered = entries.filter(e => {
          if (!e.cursor) return true;
          const ec = decodeCursor(e.cursor);
          return ec ? ec.i > cursor.i : true;
        });
        const total = filtered.length;
        const sliced = params?.offset ? filtered.slice(params.offset) : filtered;
        const page = params?.limit ? sliced.slice(0, params.limit) : sliced;
        const lastCursor: string | undefined = page.at(-1)?.cursor;
        return { entries: page, total, ...(lastCursor ? { nextCursor: lastCursor } : {}) };
      }
    }

    const total = entries.length;
    const sliced = params?.offset ? entries.slice(params.offset) : entries;
    const page = params?.limit ? sliced.slice(0, params.limit) : sliced;
    return { entries: page, total };
  }

  public async getById(id: LogId): Promise<StoredAuditEntry | null> {
    const buf = this.#buffer.find(e => e.id === id);
    if (buf) return buf;

    const result = await this.bucket.list({ prefix: this.#config.prefix, limit: 100 });
    for (const obj of result.objects) {
      const data = await this.bucket.get(obj.key);
      if (!data) continue;
      try {
        const batch: StoredAuditEntry[] = JSON.parse(new TextDecoder().decode(data.body));
        const found = batch.find(e => e.id === id);
        if (found) return found;
      } catch { continue; }
    }
    return null;
  }

  // ─── IAuditAdmin ───


  public async prune(beforeTs: number): Promise<number> {
    const result = await this.bucket.list({ prefix: this.#config.prefix, limit: 500 });
    let removed = 0;
    for (const obj of result.objects) {
      const tsMatch = /(\d{13})-/.exec(obj.key);
      if (tsMatch && parseInt(tsMatch[1]!) < beforeTs) {
        await this.bucket.delete(obj.key);
        removed++;
      }
    }
    return removed;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface contract requires Promise<T>
  public async pruneByIds(_ids: readonly string[]): Promise<number> {
    return 0; // R2 delete is per-key; full implementation would need an index
  }

  // ─── Lifecycle ───

  /** Start auto-flushing the write buffer. */
  public startAutoFlush(): void {
    if (this.#flushTimer) return;
    this.#flushTimer = setInterval(() => this.flush().catch(() => { /* noop */ }), this.#config.flushIntervalMs);
  }

  public stopAutoFlush(): void {
    if (this.#flushTimer) {
      clearInterval(this.#flushTimer);
      this.#flushTimer = null;
    }
  }

  public async dispose(): Promise<void> {
    this.stopAutoFlush();
    await this.flush();
  }

  // ─── Cursor validation ───

  #validateCursor(c: { s: string; i: number; b: string; m: number; t: number; x: string }): boolean {
    const expected = xorHash({ s: c.s, i: c.i, b: c.b, m: c.m, t: c.t });
    return c.x === expected;
  }
}

/** Derive a short machine hash from a boot UUID for cursor.s field. */
function hashBootId(bootId: string): string {
  let h = 0;
  for (let i = 0; i < bootId.length; i++) h ^= bootId.charCodeAt(i) << ((i % 4) * 8);
  return (h >>> 0).toString(16).padStart(8, '0');
}
