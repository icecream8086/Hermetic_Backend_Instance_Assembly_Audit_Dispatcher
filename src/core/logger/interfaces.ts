import type { LogInput, LogEntry, LogQuery } from './types.ts';
import type { LogId, Facility } from '../brand.ts';

export enum AuditTier {
  AUDITABLE = 'auditable',
  BEST_EFFORT = 'best-effort',
}

/**
 * Business-layer write interface.
 */
export interface ILogWriter {
  /** Audit mode: write and await single-entry persistence + tail advancement. Returns the log id. */
  logSync(input: LogInput): Promise<LogId>;

  /** Non-audit mode: enqueue to buffer, fire-and-forget. */
  logAsync(input: LogInput): Promise<void>;
}

/**
 * Business-layer read interface.
 */
export interface ILogReader {
  query(params: LogQuery): Promise<LogEntry[]>;
  getById(id: LogId): Promise<LogEntry | null>;
}

/**
 * Administrative interface for recovery / archival tooling.
 * NOT injected into request-scoped components.
 */
export interface ILogAdmin {
  forceSetTail(facility: Facility, tailId: LogId): Promise<void>;
  prune(beforeTs: number): Promise<number>;
}

/**
 * Full logger aggregate exposed to request handlers.
 */
export interface ILogger extends ILogWriter, ILogReader {
  readonly auditTier: AuditTier;
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Router resolves a facility to its writable/readable logger pair.
 */
export interface ILogRouter {
  resolve(facility: Facility): ILogWriter & ILogReader;
  register(facility: Facility, logger: ILogger): void;
}

export type { LogInput, LogEntry, LogQuery } from './types.ts';
