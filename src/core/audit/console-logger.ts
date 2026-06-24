import type { IAuditLogger, AuditEntry, StoredAuditEntry, LogQuery } from './types.ts';
import { AuditTier } from './types.ts';
import type { LogId } from '../brand.ts';
import { generateLogId } from '../brand.ts';
import { KernLevel, resolveFacility, encodePriority } from './kern-level.ts';
import { shouldLog } from './log-policy.ts';
import { formatDmesgLine } from '../utils/dmesg.ts';

/** Global panic hook — called when a CRIT-or-below log is written. */
let _onPanic: ((msg: string) => void) | null = null;
export function setPanicHandler(handler: ((msg: string) => void) | null): void {
  _onPanic = handler;
}

/** Minimal console logger for local development. */
export class ConsoleLogger implements IAuditLogger {
  readonly auditTier = AuditTier.BEST_EFFORT;
  #entries: AuditEntry[] = [];

  async write(entry: AuditEntry): Promise<void> {
    await this.log(entry);
  }

  async writeSync(entry: AuditEntry): Promise<LogId> {
    return this.log(entry);
  }

  private async log(entry: AuditEntry): Promise<LogId> {
    const id = generateLogId();
    const facilityCode = resolveFacility(entry.facility);
    const stored: StoredAuditEntry = {
      id,
      ...entry,
      priority: encodePriority(facilityCode, entry.level),
      timestamp: Date.now(),
    };
    this.#entries.push(stored);
    if (shouldLog(entry.facility, entry.level)) {
      this.#print(stored);
    }
    if (entry.level <= KernLevel.CRIT) {
      console.error(`\x1b[31m🔥 KERNEL PANIC: ${entry.message}\x1b[0m`);
      _onPanic?.(entry.message);
    }
    return id;
  }

  async query(params?: LogQuery): Promise<{ entries: StoredAuditEntry[]; nextCursor?: string; total?: number }> {
    let result: StoredAuditEntry[] = this.#entries as StoredAuditEntry[];
    if (params?.facility) result = result.filter(e => e.facility === params.facility);
    if (params?.startTs !== undefined) result = result.filter(e => e.timestamp >= params.startTs!);
    if (params?.endTs !== undefined) result = result.filter(e => e.timestamp <= params.endTs!);
    const total = result.length;
    if (params?.limit) result = result.slice(0, params.limit);
    return { entries: result, total };
  }

  async getById(id: LogId): Promise<StoredAuditEntry | null> {
    return (this.#entries as StoredAuditEntry[]).find(e => e.id === id) ?? null;
  }

  async flush(): Promise<void> { /* noop */ }
  async dispose(): Promise<void> { this.#entries = []; }

  async forceSetTail(_facility: any, _tailId: any): Promise<void> {}
  async prune(_beforeTs: number): Promise<number> { return 0; }
  async pruneByIds(_ids: readonly string[]): Promise<number> { return 0; }

  #print(entry: AuditEntry & { timestamp: number }): void {
    const actorId = entry.actorId ?? (entry.metadata?.actorId as string | undefined);
    console.log(formatDmesgLine(entry.message, actorId));
  }
}
