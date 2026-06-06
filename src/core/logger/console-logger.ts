import type { ILogger } from './interfaces.ts';
import { AuditTier } from './interfaces.ts';
import type { LogInput, LogEntry, LogQuery } from './types.ts';
import type { LogId } from '../brand.ts';
import { generateLogId } from '../brand.ts';
import { shouldLog } from './log-policy.ts';
import { formatDmesgLine } from '../utils/dmesg.ts';

/** Minimal console logger for local development. */
export class ConsoleLogger implements ILogger {
  readonly auditTier = AuditTier.BEST_EFFORT;
  #entries: LogEntry[] = [];

  async logSync(input: LogInput): Promise<LogId> {
    const id = generateLogId();
    const entry: LogEntry = {
      id,
      facility: input.facility,
      level: input.level,
      timestamp: Date.now(),
      message: input.message,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    } as LogEntry;
    this.#entries.push(entry);
    if (shouldLog(input.facility, input.level)) {
      this.#print(entry);
    }
    return id;
  }

  async logAsync(input: LogInput): Promise<void> {
    await this.logSync(input);
  }

  async query(params: LogQuery): Promise<LogEntry[]> {
    let result = this.#entries.filter(e =>
      e.facility === params.facility &&
      (params.startTs === undefined || e.timestamp >= params.startTs) &&
      (params.endTs === undefined || e.timestamp <= params.endTs)
    );
    if (params.limit) result = result.slice(0, params.limit);
    return result;
  }

  async getById(id: LogId): Promise<LogEntry | null> {
    return this.#entries.find(e => e.id === id) ?? null;
  }

  async flush(): Promise<void> { /* noop */ }
  async dispose(): Promise<void> { this.#entries = []; }

  #print(entry: LogEntry): void {
    const actorId = entry.actorId ?? (entry.metadata?.actorId as string | undefined);
    console.log(formatDmesgLine(entry.message, actorId));
  }
}
