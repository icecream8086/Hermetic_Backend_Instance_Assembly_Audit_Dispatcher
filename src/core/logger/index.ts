/**
 * @deprecated Import from 'core/audit/types.ts' or 'core/audit/index.ts' directly.
 * This module is kept temporarily for migration. Will be removed.
 */
export {
  AuditTier,
  type IAuditWriter as ILogWriter,
  type IAuditReader as ILogReader,
  type IAuditAdmin as ILogAdmin,
  type IAuditLogger as ILogger,
} from '../audit/types.ts';
export { type ILogFormatter, JsonLogFormatter } from '../audit/formatter.ts';
export {
  type AuditEntry as LogInput,
  type StoredAuditEntry as LogEntry,
  type LogQuery,
  type StorageEntry,
} from '../audit/types.ts';
export { type ILogTailCoordinator } from '../audit/tail-coordinator/interfaces.ts';
export {
  type ILogStorageWriter,
  type ILogStorageReader,
  type ILogStorageAdmin,
  type LogStorageEntry,
} from '../audit/storage-adapters/interfaces.ts';
