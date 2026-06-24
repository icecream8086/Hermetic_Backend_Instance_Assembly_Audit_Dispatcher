export {
  KernLevel, kernLevelName,
  AuditFacility, encodePriority, decodePriority, resolveFacility, facilityName,
} from './kern-level.ts';
export type {
  AuditEntry, StoredAuditEntry, LogQuery, LogQueryResult, StorageEntry,
  AuditFilter, AuditQueryResult, TrustedFields, LogCursor,
  IAuditWriter, IAuditReader, IAuditAdmin, IAuditLogger,
  AuditTier,
  /** @deprecated Use AuditEntry */
  LogInput,
  /** @deprecated Use StoredAuditEntry */
  LogEntry,
} from './types.ts';
export { encodeCursor, decodeCursor, cursorFromEntry } from './types.ts';
export { AuditTier as _AuditTier } from './types.ts';
export { formatAuditLine } from './types.ts';
export { shouldLog, shouldLogAudit, setActivePolicy, getActivePolicy, debugLog, DEFAULT_POLICY } from './log-policy.ts';
export { setBootId, trustedFromRequest, createAuditEntry } from './context.ts';
export { MESSAGE_IDS } from './message-ids.ts';
export type { MessageId } from './message-ids.ts';
export { WorkersAuditLogger } from './workers-audit-logger.ts';
export { KvAuditLogger } from './kv-audit-logger.ts';
export { HybridAuditLogger } from './hybrid-logger.ts';
export { NoopAuditLogger } from './noop-audit-logger.ts';
export { LocalAuditLogger } from './local-audit-logger.ts';
export { ConsoleLogger } from './console-logger.ts';

// R2 (Cloudflare Workers Logs integration)
export { R2AuditLogger } from './r2-logger.ts';
export type { R2Bucket, R2LoggerConfig } from './r2-logger.ts';

// Rotation (journald §9)
export {
  selectEntriesToPrune, estimateEntrySize, pruneBackend,
  DEFAULT_ROTATION, PRODUCTION_ROTATION,
} from './rotation.ts';
export type { LogRotationConfig, PruneResult } from './rotation.ts';

// Tail (journald §5 cursor-based streaming)
export {
  createTailSession, pollTail, startTail, stopTail, createWsTailHandler,
} from './tail.ts';
export type { TailSession, TailOptions, TailWsMessage } from './tail.ts';

// Namespace isolation (journald §4 trusted fields)
export {
  NamespacedAuditReader, sandboxLogReader, facilityLogReader,
  buildSandboxQuery, buildFacilityQuery,
} from './namespace.ts';
export type { LogNamespace } from './namespace.ts';

export { createAuditRouter } from './audit-router.ts';
