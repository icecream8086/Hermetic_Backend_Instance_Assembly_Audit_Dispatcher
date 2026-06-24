import type { IAuditWriter, IAuditReader, IAuditAdmin, AuditEntry, StoredAuditEntry, LogQuery } from './types.ts';
import type { LogId } from '../brand.ts';
import { generateLogId } from '../brand.ts';

export class NoopAuditLogger implements IAuditWriter, IAuditReader, IAuditAdmin {
  async write(_entry: AuditEntry): Promise<void> { /* no-op */ }
  async writeSync(_entry: AuditEntry): Promise<LogId> { return generateLogId(); }
  async query(_params?: LogQuery): Promise<{ entries: StoredAuditEntry[]; nextCursor?: string; total?: number }> {
    return { entries: [], total: 0 };
  }
  async getById(_id: LogId): Promise<StoredAuditEntry | null> { return null; }
  async forceSetTail(_facility: any, _tailId: any): Promise<void> {}
  async prune(_beforeTs: number): Promise<number> { return 0; }
  async pruneByIds(_ids: readonly string[]): Promise<number> { return 0; }
}
