import type { IAuditWriter, IAuditReader, AuditEntry, AuditFilter, AuditQueryResult } from './types.ts';

/**
 * No-op audit logger — disables audit logging entirely.
 * Useful for testing or when audit is not needed.
 */
export class NoopAuditLogger implements IAuditWriter, IAuditReader {
  async write(_entry: AuditEntry): Promise<void> {
    // no-op
  }

  query(_filter?: AuditFilter): AuditQueryResult {
    return { lines: [], total: 0, page: 1, limit: 20, totalPages: 0 };
  }
}
