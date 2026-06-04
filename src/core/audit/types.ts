import type { KernLevel } from './kern-level.ts';
import { kernLevelName } from './kern-level.ts';

/** Input for writing an audit entry. */
export interface AuditEntry {
  level: KernLevel;
  facility: string;
  message: string;
  /** Who performed the action. */
  actorId?: string | undefined;
  metadata?: Record<string, unknown>;
}

/** Persisted audit entry (what gets stored). */
export interface StoredAuditEntry {
  id: string;
  timestamp: number;
  level: KernLevel;
  facility: string;
  message: string;
  metadata?: Record<string, unknown>;
}

/** Filter rules for querying audit logs — 对标 Workers Logs 过滤规则. */
export interface AuditFilter {
  /** 最低级别 (含)，如 ERR=3 会包含 0-3 */
  levelMin?: KernLevel;
  /** 最高级别 (含) */
  levelMax?: KernLevel;
  /** 只返回指定 facility */
  facility?: string;
  /** 文本搜索 (子串匹配 message) */
  search?: string;
  /** 起始时间戳 ms */
  since?: number;
  /** 结束时间戳 ms */
  until?: number;
  /** 页码 (1-based) */
  page?: number;
  /** 每页条数 */
  limit?: number;
}

export interface AuditQueryResult {
  lines: string[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** Audit writer interface — used by services and permission module. */
export interface IAuditWriter {
  write(entry: AuditEntry): Promise<void>;
}

/** Audit reader interface — Cloudflare Log API CRUD 转发层. */
export interface IAuditReader {
  query(filter?: AuditFilter): AuditQueryResult;
}

/** Format an audit entry as a log line. */
export function formatAuditLine(timestamp: number, entry: AuditEntry): string {
  const ts = new Date(timestamp).toISOString();
  const actor = entry.actorId ? ` (actor=${entry.actorId})` : '';
  return `[${ts}] ${kernLevelName(entry.level)}: ${entry.message}${actor}`;
}
