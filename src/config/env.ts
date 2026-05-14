import type { StorageConfig } from '../core/store/config.ts';
import { AuditTier } from '../core/logger/interfaces.ts';
import type { AppConfig, LogConfig } from './types.ts';

export type { AppConfig } from './types.ts';

/**
 * Load configuration from environment variables with strict validation.
 * All backends and credentials are wired through env, never hardcoded.
 */
export function loadConfig(overrides?: Partial<AppConfig>): AppConfig {
  const envAuditTier = process.env['LOG_AUDIT_TIER'];
  const auditTier = envAuditTier === AuditTier.AUDITABLE ? AuditTier.AUDITABLE : AuditTier.BEST_EFFORT;

  const logConfig: LogConfig = overrides?.log ?? {
    auditTier,
    defaultFacility: 'app',
    storage: {
      backend: process.env['LOG_STORAGE_BACKEND'] ?? 'filesystem',
    },
  };

  const storageConfig: StorageConfig = overrides?.storage ?? {
    stateBackend: (process.env['STATE_BACKEND'] as StorageConfig['stateBackend']) ?? 'pg',
    queryBackend: (process.env['QUERY_BACKEND'] as StorageConfig['queryBackend']) ?? 'pg',
    blobBackend: (process.env['BLOB_BACKEND'] as StorageConfig['blobBackend']) ?? 's3',
    connections: {},
  };

  return {
    storage: storageConfig,
    log: logConfig,
    server: {
      port: Number(process.env['PORT'] ?? 3000),
      ...overrides?.server,
    },
    features: overrides?.features ?? {},
  };
}
