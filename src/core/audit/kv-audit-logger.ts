import type { IAtomicStore } from '../store/interfaces.ts';
import type { IAuditWriter, IAuditReader, AuditEntry, AuditFilter, AuditQueryResult, StoredAuditEntry } from './types.ts';
import { formatAuditLine } from './types.ts';
import { kernLevelName } from './kern-level.ts';
import { generateLogId } from '../brand.ts';

/** 7 days in seconds (KV expirationTtl). */
const AUDIT_TTL_SEC = 7 * 24 * 60 * 60;

const AUDIT_PREFIX = 'audit:';

/** Max entries kept in the in-memory ring buffer for query(). */
const MAX_INDEX_ENTRIES = 10_000;

/**
 * KV-backed audit logger.
 *
 * Writes formatted log lines to the atomic store (KV) with a 7-day TTL.
 * Keys are `audit:{LogId}`, created with expectedVersion=null (create-only),
 * so concurrent writes never collide.
 *
 * Maintains an in-memory ring buffer (last 10k entries) for the query()
 * interface, providing time-range, facility, and level filtering.
 *
 * 钟墙设计: 每条日志写 KV 时设 expirationTtl = 7 天，到期 KV 自动驱逐。
 * 边界条件:
 *  - FileKV 本地 dev 模式下用内存时间戳模拟 TTL，行为一致。
 *  - WRANGLER DEV 模式下 KV 真实 TTL 生效。
 */
export class KvAuditLogger implements IAuditWriter, IAuditReader {
  readonly #entries: StoredAuditEntry[] = [];
  readonly #capacity: number;

  constructor(
    private readonly atomic: IAtomicStore,
    capacity = MAX_INDEX_ENTRIES,
  ) {
    this.#capacity = capacity;
  }

  async write(entry: AuditEntry): Promise<void> {
    const id = generateLogId();
    const now = Date.now();
    const line = formatAuditLine(now, entry);

    // expectedVersion=null means "key must not exist" — safe for UUID keys.
    // Even in the astronomically unlikely event of a collision, set() returns
    // null, meaning the write silently no-ops. That's acceptable for audit.
    await this.atomic.set(AUDIT_PREFIX + id, line, null, AUDIT_TTL_SEC);

    // Maintain in-memory ring buffer for query()
    const stored: StoredAuditEntry = {
      id, timestamp: now,
      level: entry.level, facility: entry.facility,
      message: entry.message, actorId: entry.actorId,
      ...(entry.metadata ? { metadata: entry.metadata } : {}),
    };
    this.#entries.push(stored);
    if (this.#entries.length > this.#capacity) this.#entries.shift();
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
    if (filter?.search) {
      const q = filter.search.toLowerCase();
      f = f.filter(e => e.message.toLowerCase().includes(q));
    }

    const total = f.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const offset = (page - 1) * limit;
    return {
      lines: f.slice(offset, offset + limit).map(e => JSON.stringify({
        id: e.id, timestamp: e.timestamp,
        level: kernLevelName(e.level),
        facility: e.facility, message: e.message,
        ...(e.actorId ? { actorId: e.actorId } : {}),
        ...(e.metadata ? { metadata: e.metadata } : {}),
      })),
      total, page, limit, totalPages,
    };
  }
}

