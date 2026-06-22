/**
 * 统一审计日志器 — 本地开发 + Cloudflare Workers 生产自动适配。
 *
 * 写路径: 始终输出 console.log (Workers 平台采集), 同时写入持久化缓冲供查询。
 *   本地 → in-memory ring buffer (2000 条)
 *   Workers → IAtomicStore ring buffer (可配置, 自适应无 KV binding 时退化为 in-memory)
 *
 * 读路径: 从持久化缓冲查询，支持 facility/时间/关键词过滤 + 分页。
 *
 * 上线后: Logpush → R2 作为长期归档, CloudflareLogReader 可独立接入 audit API。
 * 此 logger 零外部依赖, 部署即用。
 */

import type { IAtomicStore } from '../store/interfaces.ts';
import type { IAuditWriter, IAuditReader } from './types.ts';
import type { AuditEntry, AuditFilter, AuditQueryResult, StoredAuditEntry } from './types.ts';
import { generateLogId } from '../brand.ts';
import { shouldLogAudit } from '../logger/log-policy.ts';
import { formatDmesgLine } from '../utils/dmesg.ts';

const PFX_AUDIT = 'audit:ring:';
const IDX_AUDIT = 'audit:ring:ids';
const MAX_IN_MEMORY = 2000;
const MAX_KV_BATCH = 1000;

function formatEntry(e: StoredAuditEntry): string {
  const actorId = e.actorId ?? (e.metadata?.actorId as string | undefined);
  return JSON.stringify({
    id: e.id, timestamp: e.timestamp, message: e.message,
    facility: e.facility, level: e.level,
    ...(actorId ? { actorId } : {}),
    ...(e.metadata ? { metadata: e.metadata } : {}),
  });
}

export class HybridAuditLogger implements IAuditWriter, IAuditReader {
  readonly #atomic: IAtomicStore | undefined;
  readonly #memory: StoredAuditEntry[] = [];
  readonly #maxInMemory: number;

  /** @param atomic — IAtomicStore for persistence. If undefined, uses in-memory only. */
  constructor(atomic?: IAtomicStore, maxInMemory = MAX_IN_MEMORY) {
    this.#atomic = atomic;
    this.#maxInMemory = maxInMemory;
  }

  // ─── IAuditWriter ───

  async write(entry: AuditEntry): Promise<void> {
    const now = Date.now();
    const stored: StoredAuditEntry = {
      id: generateLogId(), timestamp: now,
      level: entry.level, facility: entry.facility,
      message: entry.message, actorId: entry.actorId,
      ...(entry.metadata ? { metadata: entry.metadata } : {}),
    };

    // 1. In-memory ring buffer (always active, for immediate query)
    this.#memory.push(stored);
    if (this.#memory.length > this.#maxInMemory) this.#memory.shift();

    // 2. IAtomicStore persistence (for cross-request durability)
    if (this.#atomic) {
      await this.#persistToStore(stored).catch(() => {});
    }

    // 3. Console output → Workers Logs
    if (shouldLogAudit(entry.facility, entry.level)) {
      console.log(formatDmesgLine(entry.message, entry.actorId));
    }
  }

  // ─── IAuditReader ───

  query(filter?: AuditFilter): AuditQueryResult {
    const page = filter?.page ?? 1;
    const limit = filter?.limit ?? 50;
    const results = this.#filterEntries(filter);
    const total = results.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const offset = (page - 1) * limit;

    return {
      lines: results.slice(offset, offset + limit).map(e => formatEntry(e)),
      total, page, limit, totalPages,
    };
  }

  /** Async variant — merges in-memory + KV results when available. */
  async queryAsync(filter?: AuditFilter): Promise<AuditQueryResult> {
    const page = filter?.page ?? 1;
    const limit = filter?.limit ?? 50;

    // Merge in-memory + potentially more from KV
    const fromMem = this.#filterEntries(filter);
    let all = fromMem;

    if (this.#atomic) {
      const fromKV = await this.#queryFromStore(filter);
      // Deduplicate by id, prefer KV (more durable)
      const memIds = new Set(fromMem.map(e => e.id));
      const merged = [...fromMem, ...fromKV.filter(e => !memIds.has(e.id))];
      all = merged.sort((a, b) => b.timestamp - a.timestamp);
    }

    const total = all.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const offset = (page - 1) * limit;

    return {
      lines: all.slice(offset, offset + limit).map(e => formatEntry(e)),
      total, page, limit, totalPages,
    };
  }

  // ─── Private ───

  #filterEntries(filter?: AuditFilter): StoredAuditEntry[] {
    let f = [...this.#memory];
    if (!filter) return f;
    if (filter.facility) f = f.filter(e => e.facility === filter.facility);
    if (filter.levelMin !== undefined) f = f.filter(e => e.level <= filter.levelMin!);
    if (filter.levelMax !== undefined) f = f.filter(e => e.level >= filter.levelMax!);
    if (filter.since) f = f.filter(e => e.timestamp >= filter.since!);
    if (filter.until) f = f.filter(e => e.timestamp <= filter.until!);
    if (filter.search) {
      const q = filter.search.toLowerCase();
      f = f.filter(e => e.message.toLowerCase().includes(q));
    }
    return f;
  }

  async #persistToStore(e: StoredAuditEntry): Promise<void> {
    if (!this.#atomic) return;

    // Ring buffer via IAtomicStore: append to a list, trim if over limit
    const idx = await this.#atomic.get<string[]>(IDX_AUDIT);
    const ids = idx?.value ?? [];
    ids.push(e.id);
    if (ids.length > MAX_KV_BATCH) ids.shift(); // ring buffer trim

    await this.#atomic.set(`${PFX_AUDIT}${e.id}`, e, null);
    await this.#atomic.set(IDX_AUDIT, ids, idx?.version ?? null);
  }

  async #queryFromStore(filter?: AuditFilter): Promise<StoredAuditEntry[]> {
    if (!this.#atomic) return [];

    const idx = await this.#atomic.get<string[]>(IDX_AUDIT);
    if (!idx) return [];

    const entries = (await Promise.all(
      idx.value.map(id => this.#atomic!.get<StoredAuditEntry>(PFX_AUDIT + id)),
    )).filter(e => e).map(e => e!.value);

    // Apply filters
    let f = entries;
    if (filter?.facility) f = f.filter(e => e.facility === filter.facility);
    if (filter?.levelMin !== undefined) f = f.filter(e => e.level <= filter.levelMin!);
    if (filter?.levelMax !== undefined) f = f.filter(e => e.level >= filter.levelMax!);
    if (filter?.since) f = f.filter(e => e.timestamp >= filter.since!);
    if (filter?.until) f = f.filter(e => e.timestamp <= filter.until!);
    if (filter?.search) {
      const q = filter.search.toLowerCase();
      f = f.filter(e => e.message.toLowerCase().includes(q));
    }
    return f;
  }
}
