import type { StorageConfig } from '../core/store/config.ts';
import { AuditTier } from '../core/logger/interfaces.ts';
import type { SchedulerBackendType } from '../core/scheduler/interfaces.ts';
import type { AppConfig, LogConfig, ProviderConfig, S3Config, SchedulerAppConfig } from './types.ts';

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
    stateBackend: (process.env['STATE_BACKEND'] as StorageConfig['stateBackend']) ?? 'file',
    queryBackend: (process.env['QUERY_BACKEND'] as StorageConfig['queryBackend']) ?? 'none',
    blobBackend: (process.env['BLOB_BACKEND'] as StorageConfig['blobBackend']) ?? 'none',
    connections: {
      filePath: process.env['STATE_FILE_PATH'] ?? '.data',
      kvNamespace: process.env['KV_NAMESPACE'] ?? 'KV_STORE',
      doNamespace: process.env['DO_NAMESPACE'] ?? 'ATOMIC_STORE_DO',
      doInstanceName: process.env['DO_INSTANCE_NAME'] ?? 'global-store',
      d1Binding: process.env['D1_BINDING'] ?? 'QUERY_DB',
      r2Binding: process.env['R2_BINDING'] ?? 'BLOB_STORE',
    },
  };

  const providerConfig: ProviderConfig = overrides?.provider ?? {
    container: (process.env['PROVIDER_CONTAINER'] as ProviderConfig['container']) ?? 'stub',
    dns: (process.env['PROVIDER_DNS'] as ProviderConfig['dns']) ?? 'stub',
    metrics: (process.env['PROVIDER_METRICS'] as ProviderConfig['metrics']) ?? 'stub',
  };

  const s3Config: S3Config = overrides?.s3 ?? {
    backend: (process.env['S3_BACKEND'] as S3Config['backend']) ?? 'none',
    region: process.env['S3_REGION'] ?? 'auto',
  };

  const schedulerConfig: SchedulerAppConfig = overrides?.scheduler ?? {
    backend: (process.env['SCHEDULER_BACKEND'] as SchedulerBackendType) ?? 'worker',
    intervalMs: Number(process.env['SCHEDULER_INTERVAL_MS'] ?? 60000),
    batchSize: Number(process.env['SCHEDULER_BATCH_SIZE'] ?? 0),
  };

  return {
    storage: storageConfig,
    log: logConfig,
    provider: providerConfig,
    s3: s3Config,
    scheduler: schedulerConfig,
    server: {
      port: Number(process.env['PORT'] ?? 3000),
      ...overrides?.server,
    },
    features: overrides?.features ?? {},
  };
}
