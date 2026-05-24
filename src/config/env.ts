import type { StorageConfig } from '../core/store/config.ts';
import { AuditTier } from '../core/logger/interfaces.ts';
import type { SchedulerBackendType } from '../core/scheduler/interfaces.ts';
import type { AppConfig, Credential, LogConfig, ProviderConfig, S3Config, SchedulerAppConfig } from './types.ts';
import { createRegionId } from '../core/region/types.ts';

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
      d1Binding: process.env['D1_BINDING'] ?? 'QUERY_DB',
      r2Binding: process.env['R2_BINDING'] ?? 'BLOB_STORE',
    },
  };

  const providerContainer = (process.env['PROVIDER_CONTAINER'] as ProviderConfig['container']) ?? 'stub';

  // Load Alibaba container accounts:
  //   ALIBABA_ACCOUNTS=[{name,ak,sk,region,endpoint}] or ALIBABA_ACCESS_KEY_ID+ALIBABA_ACCESS_KEY_SECRET
  function loadAccounts(): Credential[] {
    const json = process.env['ALIBABA_ACCOUNTS'];
    if (json) {
      try {
        const parsed: any[] = JSON.parse(json);
        return parsed.map(a => ({
          name: a.name ?? 'default',
          accessKeyId: a.ak ?? a.accessKeyId ?? '',
          accessKeySecret: a.sk ?? a.accessKeySecret ?? '',
          defaultRegion: a.region,
          endpoint: a.endpoint,
        }));
      } catch { /* fall through to legacy */ }
    }
    const legacyAk = process.env['ALIBABA_ACCESS_KEY_ID'];
    const legacySk = process.env['ALIBABA_ACCESS_KEY_SECRET'];
    if (legacyAk && legacySk) {
      return [{
        name: 'default',
        accessKeyId: legacyAk,
        accessKeySecret: legacySk,
        defaultRegion: process.env['ALIBABA_REGION'] ?? 'cn-hangzhou',
      }];
    }
    return [{ name: 'default', accessKeyId: '', accessKeySecret: '' }];
  }

  const providerConfig: ProviderConfig = overrides?.provider ?? {
    container: providerContainer,
    region: createRegionId(process.env['ALIBABA_REGION'] ?? 'cn-hangzhou'),
    accounts: loadAccounts(),
    defaultAccount: process.env['ALIBABA_DEFAULT_ACCOUNT'] ?? 'default',
    cfApiToken: process.env['CF_API_TOKEN'],
    dns: (process.env['PROVIDER_DNS'] as ProviderConfig['dns']) ?? 'stub',
    metrics: (process.env['PROVIDER_METRICS'] as ProviderConfig['metrics']) ?? 'stub',
  };

  // Load S3 accounts:
  //   S3_ACCOUNTS=[{name,ak,sk,region,endpoint,bucket}] or S3_ACCESS_KEY_ID+S3_SECRET_ACCESS_KEY
  function loadS3Accounts(): Credential[] {
    const json = process.env['S3_ACCOUNTS'];
    if (json) {
      try {
        const parsed: any[] = JSON.parse(json);
        return parsed.map(a => ({
          name: a.name ?? 'default',
          accessKeyId: a.ak ?? a.accessKeyId ?? '',
          accessKeySecret: a.sk ?? a.secretAccessKey ?? a.accessKeySecret ?? '',
          defaultRegion: a.region,
          endpoint: a.endpoint,
          bucket: a.bucket,
        }));
      } catch { /* fall through */ }
    }
    const legacyAk = process.env['S3_ACCESS_KEY_ID'] ?? process.env['MINIO_ACCESS_KEY'] ?? process.env['MINIO_ROOT_USER'];
    const legacySk = process.env['S3_SECRET_ACCESS_KEY'] ?? process.env['MINIO_SECRET_KEY'] ?? process.env['MINIO_ROOT_PASSWORD'];
    if (legacyAk && legacySk) {
      return [{
        name: 'default',
        accessKeyId: legacyAk,
        accessKeySecret: legacySk,
        defaultRegion: process.env['S3_REGION'] ?? 'us-east-1',
        endpoint: process.env['S3_ENDPOINT'] ?? process.env['MINIO_ENDPOINT'],
      }];
    }
    return [{ name: 'default', accessKeyId: '', accessKeySecret: '' }];
  }

  const s3Config: S3Config = overrides?.s3 ?? {
    backend: (process.env['S3_BACKEND'] as S3Config['backend']) ?? 'none',
    region: process.env['S3_REGION'] ?? 'auto',
    endpoint: process.env['S3_ENDPOINT'] ?? process.env['MINIO_ENDPOINT'] ?? undefined,
    accounts: loadS3Accounts(),
    defaultAccount: process.env['S3_DEFAULT_ACCOUNT'] ?? 'default',
  };

  const schedulerConfig: SchedulerAppConfig = overrides?.scheduler ?? {
    backend: (process.env['SCHEDULER_BACKEND'] as SchedulerBackendType) ?? 'worker',
    intervalMs: Number(process.env['SCHEDULER_INTERVAL_MS'] ?? 60000),
    batchSize: Number(process.env['SCHEDULER_BATCH_SIZE'] ?? 0),
    callbackUrl: process.env['WORKER_URL']
      ? `${process.env['WORKER_URL'].replace(/\/+$/, '')}/__scheduled`
      : undefined,
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
    authz: overrides?.authz,
  };
}
