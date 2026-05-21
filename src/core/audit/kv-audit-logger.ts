import type { IAtomicStore } from '../store/interfaces.ts';
import type { IAuditWriter, AuditEntry } from './types.ts';
import { formatAuditLine } from './types.ts';
import { generateLogId } from '../brand.ts';

/** 7 days in seconds (KV expirationTtl). */
const AUDIT_TTL_SEC = 7 * 24 * 60 * 60;

const AUDIT_PREFIX = 'audit:';

/**
 * KV-backed audit logger.
 *
 * Writes formatted log lines to the atomic store (KV) with a 7-day TTL.
 * Keys are `audit:{LogId}`, created with expectedVersion=null (create-only),
 * so concurrent writes never collide.
 *
 * 钟墙设计: 每条日志写 KV 时设 expirationTtl = 7 天，到期 KV 自动驱逐。
 * 边界条件:
 *  - FileKV 本地 dev 模式下用内存时间戳模拟 TTL，行为一致。
 *  - WRANGLER DEV 模式下 KV 真实 TTL 生效。
 */
export class KvAuditLogger implements IAuditWriter {
  constructor(private readonly atomic: IAtomicStore) {}

  async write(entry: AuditEntry): Promise<void> {
    const id = generateLogId();
    const now = Date.now();
    const line = formatAuditLine(now, entry);

    // expectedVersion=null means "key must not exist" — safe for UUID keys.
    // Even in the astronomically unlikely event of a collision, set() returns
    // null, meaning the write silently no-ops. That's acceptable for audit.
    await this.atomic.set(AUDIT_PREFIX + id, line, null, AUDIT_TTL_SEC);
  }
}
