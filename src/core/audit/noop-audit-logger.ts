import type { IAuditWriter, IAuditReader, IAuditAdmin, AuditEntry, StoredAuditEntry, LogQuery } from './types.ts';
import type { LogId } from '../brand.ts';
import { generateLogId } from '../brand.ts';

export class NoopAuditLogger implements IAuditWriter, IAuditReader, IAuditAdmin {
  public async write(_entry: AuditEntry): Promise<void> { /* no-op */ }
  public async writeSync(_entry: AuditEntry): Promise<LogId> { return generateLogId(); }
  public async query(_params?: LogQuery): Promise<{ entries: StoredAuditEntry[]; nextCursor?: string; total?: number }> {
    return { entries: [], total: 0 };
  }
  public async getById(_id: LogId): Promise<StoredAuditEntry | null> { return null; }
  public async forceSetTail(_facility: any, _tailId: any): Promise<void> {}
  public async prune(_beforeTs: number): Promise<number> { return 0; }
  public async pruneByIds(_ids: readonly string[]): Promise<number> { return 0; }
}
