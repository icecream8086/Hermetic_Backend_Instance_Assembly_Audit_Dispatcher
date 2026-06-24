import type { IAuditWriter, IAuditReader, IAuditAdmin, AuditEntry, StoredAuditEntry, LogQuery } from './types.ts';
import type { LogId } from '../brand.ts';
import { KernLevel, kernLevelName, resolveFacility, encodePriority } from './kern-level.ts';
import { shouldLogAudit } from './log-policy.ts';

/**
 * Workers Logs audit logger.
 *
 * Write: console.log/warn/error → Workers Logs (Cloudflare platform collection)
 * Query: forwarding layer — does not store logs locally.
 */
export class WorkersAuditLogger implements IAuditWriter, IAuditReader, IAuditAdmin {
  async write(entry: AuditEntry): Promise<void> {
    this.#output(entry);
  }

  async writeSync(entry: AuditEntry): Promise<LogId> {
    const id = crypto.randomUUID() as LogId;
    const facilityCode = resolveFacility(entry.facility);
    entry.priority = encodePriority(facilityCode, entry.level);
    this.#output(entry);
    return id;
  }

  #output(entry: AuditEntry): void {
    const ts = new Date().toISOString();
    const facility = entry.facility ?? 'audit';
    const levelName = kernLevelName(entry.level);

    if (!shouldLogAudit(facility, entry.level)) return;

    const line = `[${ts}] ${levelName}: [${facility}] ${entry.message}`;
    const meta = entry.metadata ? JSON.stringify(entry.metadata) : undefined;

    if (entry.level <= KernLevel.ERR) {
      meta ? console.error(line, meta) : console.error(line);
    } else if (entry.level === KernLevel.WARNING) {
      meta ? console.warn(line, meta) : console.warn(line);
    } else {
      meta ? console.log(line, meta) : console.log(line);
    }
  }

  async query(_params?: LogQuery): Promise<{ entries: StoredAuditEntry[]; nextCursor?: string; total?: number }> {
    return { entries: [], total: 0 };
  }

  async getById(_id: LogId): Promise<StoredAuditEntry | null> {
    return null;
  }

  async forceSetTail(_facility: any, _tailId: any): Promise<void> {}
  async prune(_beforeTs: number): Promise<number> { return 0; }
  async pruneByIds(_ids: readonly string[]): Promise<number> { return 0; }
}
