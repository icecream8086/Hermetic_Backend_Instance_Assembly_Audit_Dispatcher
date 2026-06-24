/**
 * R2-backed audit logger — Cloudflare Workers Logs integration.
 *
 * journald §9 persistent storage model:
 *   Log entries are written to R2 (Cloudflare Object Storage).
 *   Query is a forward-only scan through stored blobs.
 *
 * Usage:
 *   - Logpush: Cloudflare Workers Logpush → R2 bucket
 *   - Direct: write audit entries as JSON lines in R2 objects
 *   - Query: list and parse R2 objects with time-range filtering
 */

import type { IAuditWriter, IAuditReader, IAuditAdmin, AuditEntry, StoredAuditEntry, LogQuery } from './types.ts';
import type { LogId } from '../brand.ts';
import { generateLogId } from '../brand.ts';
import { resolveFacility, encodePriority } from './kern-level.ts';

// ─── R2 abstraction ───

export interface R2Bucket {
  put(key: string, value: string | ArrayBuffer | Uint8Array): Promise<void>;
  get(key: string): Promise<{ body: ArrayBuffer; key: string } | null>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    objects: Array<{ key: string; size: number; uploaded: Date }>;
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

// ─── R2 Audit Logger ───

export class R2AuditLogger implements IAuditWriter, IAuditReader, IAuditAdmin {
  readonly #buffer: StoredAuditEntry[] = [];
  readonly #config: R2LoggerConfig;
  #flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly bucket: R2Bucket,
    config: Partial<R2LoggerConfig> = {},
  ) {
    this.#config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── IAuditWriter ───

  async write(entry: AuditEntry): Promise<void> {
    await this.#bufferEntry(entry);
  }

  async writeSync(entry: AuditEntry): Promise<LogId> {
    return this.#bufferEntry(entry);
  }

  async #bufferEntry(entry: AuditEntry): Promise<LogId> {
    const id = generateLogId();
    const facilityCode = resolveFacility(entry.facility);
    const stored: StoredAuditEntry = {
      id, timestamp: Date.now(),
      priority: encodePriority(facilityCode, entry.level),
      level: entry.level, facility: entry.facility,
      message: entry.message,
      actorId: entry.actorId,
      ...(entry.metadata ? { metadata: entry.metadata } : {}),
    };
    this.#buffer.push(stored);

    if (this.#buffer.length >= this.#config.batchSize) {
      await this.flush();
    }
    return id;
  }

  async flush(): Promise<void> {
    if (this.#buffer.length === 0) return;
    const batch = this.#buffer.splice(0);
    const now = Date.now();
    const key = `${this.#config.prefix}${now}-${batch[0]!.id}.json`;
    await this.bucket.put(key, JSON.stringify(batch));
  }

  // ─── IAuditReader ───

  async query(params?: LogQuery): Promise<{ entries: StoredAuditEntry[]; nextCursor?: string; total?: number }> {
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

    // Flush in-memory buffer entries that might be relevant
    if (this.#buffer.length > 0) {
      let buf = [...this.#buffer];
      if (params?.facility) buf = buf.filter(e => e.facility === params.facility);
      entries.push(...buf);
    }

    return {
      entries: entries.slice(0, limit),
      ...(listResult.truncated && listResult.cursor ? { nextCursor: listResult.cursor } : {}),
      total: entries.length,
    };
  }

  async getById(id: LogId): Promise<StoredAuditEntry | null> {
    // Check buffer first
    const buf = this.#buffer.find(e => e.id === id);
    if (buf) return buf;

    // Scan R2 (expensive — use query instead)
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

  async forceSetTail(_facility: any, _tailId: any): Promise<void> {}

  async prune(beforeTs: number): Promise<number> {
    const result = await this.bucket.list({ prefix: this.#config.prefix, limit: 500 });
    let removed = 0;
    for (const obj of result.objects) {
      // Parse timestamp from key: prefix/ts-id.json
      const tsMatch = obj.key.match(/(\d{13})-/);
      if (tsMatch && parseInt(tsMatch[1]!) < beforeTs) {
        await this.bucket.delete(obj.key);
        removed++;
      }
    }
    return removed;
  }

  async pruneByIds(_ids: readonly string[]): Promise<number> {
    // R2 delete is per-key. Filter to matching IDs by scanning.
    // For efficiency, this is a simplified implementation.
    return 0; // For now — full implementation would need an index
  }

  // ─── Lifecycle ───

  /** Start auto-flushing the write buffer. */
  startAutoFlush(): void {
    if (this.#flushTimer) return;
    this.#flushTimer = setInterval(() => this.flush(), this.#config.flushIntervalMs);
  }

  stopAutoFlush(): void {
    if (this.#flushTimer) {
      clearInterval(this.#flushTimer);
      this.#flushTimer = null;
    }
  }

  async dispose(): Promise<void> {
    this.stopAutoFlush();
    await this.flush();
  }
}
