import type { IAuditWriter, IAuditReader, AuditEntry, AuditFilter, AuditQueryResult } from './types.ts';
import { KernLevel, kernLevelName } from './kern-level.ts';
import { shouldLogAudit } from '../logger/log-policy.ts';

/**
 * Workers Logs 纯转发审计日志实现。
 *
 * 写入: console.log/warn/error → Workers Logs (Cloudflare 平台采集)
 * 查询: CRUD 转发层接口，直接穿透查询不在本进程存储任何日志。
 */
export class WorkersAuditLogger implements IAuditWriter, IAuditReader {
  // ─── IAuditWriter ───

  write(entry: AuditEntry): Promise<void> {
    const ts = new Date().toISOString();
    const facility = entry.facility ?? 'audit';
    const levelName = kernLevelName(entry.level);

    // Respect log policy — skip if below configured threshold
    if (!shouldLogAudit(facility, entry.level)) {
      return Promise.resolve();
    }

    const line = `[${ts}] ${levelName}: [${facility}] ${entry.message}`;
    const meta = entry.metadata ? JSON.stringify(entry.metadata) : undefined;

    if (entry.level <= KernLevel.ERR) {
      meta ? console.error(line, meta) : console.error(line);
    } else if (entry.level === KernLevel.WARNING) {
      meta ? console.warn(line, meta) : console.warn(line);
    } else {
      meta ? console.log(line, meta) : console.log(line);
    }

    return Promise.resolve();
  }

  // ─── IAuditReader (转发层，待对接 Logpush 后端) ───

  query(_filter?: AuditFilter): AuditQueryResult {
    return { lines: [], total: 0, page: 1, limit: 20, totalPages: 0 };
  }
}
