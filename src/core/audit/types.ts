import type { KernLevel } from './kern-level.ts';
import type { LogId, Facility, SerializedBody } from '../brand.ts';
import { formatDmesgLine } from '../utils/dmesg.ts';

// ═══════════════════════════════════════════════════════════
// Core entry types (unified audit + logger)
// ═══════════════════════════════════════════════════════════

/**
 * Trusted fields — auto-injected by the logging framework.
 * Prefixed with _ to distinguish from caller-provided fields (journald convention).
 * These fields CANNOT be set by business code — only the middleware/log framework sets them.
 */
export interface TrustedFields {
  _request_id?: string;
  _user_id?: string;
  _source_ip?: string;
  _boot_id?: string;
  _sandbox_id?: string;
}

/** Input for writing an audit/log entry. */
export interface AuditEntry {
  level: KernLevel;
  facility: string;
  message: string;
  actorId?: string | undefined;
  metadata?: Record<string, unknown>;
  /** Computed priority = facility × 8 + level. Set by logger, not caller. */
  priority?: number;
  /** Auto-injected trusted fields. Set by the logging framework. */
  trusted?: TrustedFields;
}

/** Persisted entry (what gets stored). */
export interface StoredAuditEntry {
  id: string;
  timestamp: number;
  level: KernLevel;
  facility: string;
  message: string;
  actorId?: string | undefined;
  metadata?: Record<string, unknown>;
  priority?: number;
  trusted?: TrustedFields;
  /** Journald-style cursor for incremental consumption with tamper detection. */
  cursor?: string;
}

/**
 * Cursor for incremental log consumption (journald-style).
 * Format: "s=<machine>;i=<seq>;b=<boot>;m=<mono>;t=<real>;x=<xor>"
 */
export interface LogCursor {
  s: string;  // machine hash
  i: number;  // sequence number
  b: string;  // boot ID
  m: number;  // monotonic timestamp (performance.now ms)
  t: number;  // wall clock timestamp (Date.now ms)
  x: string;  // xor hash of above fields (tamper detection)
}

/** Result of a log query with cursor for incremental consumption. */
export interface LogQueryResult {
  entries: StoredAuditEntry[];
  /** Cursor pointing to the last entry in this batch. Pass as `afterCursor` for next page. */
  nextCursor?: string;
  /** Total count matching the query (may be approximate). */
  total?: number;
}

/** Query parameters for log retrieval. */
export interface LogQuery {
  facility?: string;
  startTs?: number;
  endTs?: number;
  limit?: number;
  /** Skip first N entries (for page-based pagination). */
  offset?: number;
  /** Resume from after this cursor (exclusive). Use nextCursor from previous LogQueryResult. */
  afterCursor?: string;
  /** Filter by priority range (inclusive). priorityMin=16 → SANDBOX.EMERG and above. */
  priorityMin?: number;
  priorityMax?: number;
}

/** Encode a LogCursor to its string representation. */
export function encodeCursor(c: LogCursor): string {
  return `s=${c.s};i=${String(c.i)};b=${c.b};m=${String(c.m)};t=${String(c.t)};x=${c.x}`;
}

/** Decode a cursor string back to LogCursor. Returns null if format is invalid. */
export function decodeCursor(raw: string): LogCursor | null {
  try {
    const map = new Map(raw.split(';').map(p => p.split('=', 2) as [string, string]));
    return {
      s: map.get('s') ?? '', i: Number(map.get('i')), b: map.get('b') ?? '',
      m: Number(map.get('m')), t: Number(map.get('t')), x: map.get('x') ?? '',
    };
  } catch { return null; }
}

/** Build a cursor from a StoredAuditEntry. */
export function cursorFromEntry(entry: StoredAuditEntry, bootId: string, seq: number, machineHash: string): LogCursor {
  const cursor: LogCursor = {
    s: machineHash, i: seq, b: bootId,
    m: Math.round(performance.now()), t: entry.timestamp,
    x: '',
  };
  cursor.x = xorHash(cursor);
  return cursor;
}

export function xorHash(c: { s: string; i: number; b: string; m: number; t: number }): string {
  const parts = [c.s, String(c.i), c.b, String(c.m), String(c.t)];
  let h = 0;
  for (const p of parts) { for (let i = 0; i < p.length; i++) h ^= p.charCodeAt(i) << ((i % 4) * 8); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Query parameters for log retrieval. */
export interface LogQuery {
  facility?: string;
  startTs?: number;
  endTs?: number;
  limit?: number;
  cursor?: string;
}

/** Pre-serialized storage entry. */
export interface StorageEntry {
  facility: string;
  id: string;
  timestamp: number;
  body: SerializedBody;
}

/** Filter rules for querying audit logs. */
export interface AuditFilter {
  levelMin?: KernLevel;
  levelMax?: KernLevel;
  facility?: string;
  search?: string;
  since?: number;
  until?: number;
  page?: number;
  limit?: number;
}

export interface AuditQueryResult {
  lines: string[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ═══════════════════════════════════════════════════════════
// Interfaces (unified writer / reader / admin)
// ═══════════════════════════════════════════════════════════

export enum AuditTier {
  AUDITABLE = 'auditable',
  BEST_EFFORT = 'best-effort',
}

/** Write interface — fire-and-forget or sync with log id. */
export interface IAuditWriter {
  write(entry: AuditEntry): Promise<void>;
  /** Sync write that returns the log id for audit chain linking. */
  writeSync(entry: AuditEntry): Promise<LogId>;
}

/** Read interface. */
export interface IAuditReader {
  query(params?: LogQuery): Promise<LogQueryResult>;
  getById(id: LogId): Promise<StoredAuditEntry | null>;
}

/** Admin interface for recovery / archival. */
export interface IAuditAdmin {
  forceSetTail(facility: Facility, tailId: LogId): Promise<void>;
  /** Remove entries older than the given timestamp. */
  prune(beforeTs: number): Promise<number>;
  /** Remove specific entries by ID. Returns count removed. */
  pruneByIds(ids: readonly string[]): Promise<number>;
}

/** Full audit logger aggregate. */
export interface IAuditLogger extends IAuditWriter, IAuditReader, IAuditAdmin {
  readonly auditTier: AuditTier;
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

/** Format an audit entry as a dmesg-style log line. */
export function formatAuditLine(_timestamp: number, entry: AuditEntry): string {
  const actorId = entry.actorId ?? (entry.metadata?.actorId as string | undefined);
  return formatDmesgLine(entry.message, actorId);
}

// ═══════════════════════════════════════════════════════════
// Backward-compat aliases (will be removed after migration)
// ═══════════════════════════════════════════════════════════

/** @deprecated Use AuditEntry */
export type LogInput = AuditEntry;
/** @deprecated Use StoredAuditEntry */
export type LogEntry = StoredAuditEntry;
/** @deprecated Use IAuditWriter */
export type ILogWriter = IAuditWriter;
/** @deprecated Use IAuditReader */
export type ILogReader = IAuditReader;
