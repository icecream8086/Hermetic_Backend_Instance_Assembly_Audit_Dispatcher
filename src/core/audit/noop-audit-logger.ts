import type { IAuditWriter, IAuditReader, AuditEntry, StoredAuditEntry, LogQuery } from './types.ts';
import type { LogId } from '../brand.ts';
import { generateLogId } from '../brand.ts';

export class NoopAuditLogger implements IAuditWriter, IAuditReader {
  async write(_entry: AuditEntry): Promise<void> { /* no-op */ }
  async writeSync(_entry: AuditEntry): Promise<LogId> {
    return generateLogId(); // no-op, but return a valid id
  }
  async query(_params?: LogQuery): Promise<{ entries: StoredAuditEntry[]; nextCursor?: string; total?: number }> {
    return { entries: [], total: 0 };
  }
  async getById(_id: LogId): Promise<StoredAuditEntry | null> { return null; }
}
