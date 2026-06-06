import type { Facility, LogId, SerializedBody } from '../brand.ts';
import type { LogLevel } from '../types.ts';

/** Input for creating a log entry (what callers provide). */
export interface LogInput {
  facility: Facility;
  level: LogLevel;
  message: string;
  /** Who performed the action. Automatically included in output. */
  actorId?: string | undefined;
  metadata?: Record<string, unknown>;
}

/** Full deserialized log entry. */
export interface LogEntry {
  id: LogId;
  facility: Facility;
  level: LogLevel;
  timestamp: number;
  message: string;
  actorId?: string | undefined;
  metadata?: Record<string, unknown>;
}

/** Query parameters for log retrieval. */
export interface LogQuery {
  facility: Facility;
  startTs?: number;
  endTs?: number;
  limit?: number;
  cursor?: string;
}

/** Pre-serialized storage entry. */
export interface StorageEntry {
  facility: Facility;
  id: LogId;
  timestamp: number;
  body: SerializedBody;
}
