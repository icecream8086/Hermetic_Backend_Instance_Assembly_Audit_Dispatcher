import type { AppConfig } from './types.ts';
import type { StorageConfig } from '../core/store/config.ts';
import type { SchedulerBackendType } from '../core/scheduler/interfaces.ts';
import { AuditTier } from '../core/audit/types.ts';
import { createRegionId } from '../core/region/types.ts';
import { AppConfigSchema } from './schema.ts';

export type { AppConfig } from './types.ts';

/**
 * Load configuration from environment variables with strict validation.
 * All backends and credentials are wired through env, never hardcoded.
 *
 * Assembly is done with legacy env vars first, then validated against
 * the Zod schema at the end. Any missing required field or invalid
 * value → clear error message at startup (not a silent null-pointer later).
 */
export function loadConfig(overrides?: Partial<AppConfig>): AppConfig {
  const envAuditTier = process.env['LOG_AUDIT_TIER'];
  const auditTier = envAuditTier === AuditTier.AUDITABLE ? AuditTier.AUDITABLE : AuditTier.BEST_EFFORT;

  const logConfig = overrides?.log ?? {
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

  const providerContainer = (process.env['PROVIDER_CONTAINER'] as any) ?? 'stub';

  function loadAccounts(): any[] {
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
          ...(a.extra ? { extra: a.extra } : {}),
          ...(a.registryCredentials ? { extra: { registryCredentials: a.registryCredentials } } : {}),
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

  const providerConfig = overrides?.provider ?? {
    container: providerContainer,
    region: createRegionId(process.env['ALIBABA_REGION'] ?? 'cn-hangzhou'),
    accounts: loadAccounts(),
    defaultAccount: process.env['ALIBABA_DEFAULT_ACCOUNT'] ?? 'default',
    cfApiToken: process.env['CF_API_TOKEN'],
    dns: (process.env['PROVIDER_DNS'] as any) ?? 'stub',
    metrics: (process.env['PROVIDER_METRICS'] as any) ?? 'stub',
  };

  function loadS3Accounts(): any[] {
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
          ...(a.extra ? { extra: a.extra } : {}),
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

  const s3Config = overrides?.s3 ?? {
    backend: (process.env['S3_BACKEND'] as any) ?? 'none',
    region: process.env['S3_REGION'] ?? 'auto',
    endpoint: process.env['S3_ENDPOINT'] ?? process.env['MINIO_ENDPOINT'] ?? undefined,
    accounts: loadS3Accounts(),
    defaultAccount: process.env['S3_DEFAULT_ACCOUNT'] ?? 'default',
  };

  const schedulerConfig = overrides?.scheduler ?? {
    backend: (process.env['SCHEDULER_BACKEND'] as SchedulerBackendType) ?? 'worker',
    intervalMs: Number(process.env['SCHEDULER_INTERVAL_MS'] ?? 60000),
    batchSize: Number(process.env['SCHEDULER_BATCH_SIZE'] ?? 0),
    callbackUrl: process.env['WORKER_URL']
      ? `${process.env['WORKER_URL'].replace(/\/+$/, '')}/__scheduled`
      : undefined,
  };

  const corsOriginsRaw = process.env['CORS_ORIGINS'] ?? 'http://localhost:8086';

  const rateLimitEnabled = process.env['RATE_LIMIT_ENABLED'];
  const rateLimitBypassIpsRaw = process.env['RATE_LIMIT_BYPASS_IPS'];
  const rateLimitBypassToken = process.env['RATE_LIMIT_BYPASS_TOKEN'] || undefined;

  const assembled = {
    storage: storageConfig,
    log: logConfig,
    provider: providerConfig,
    s3: s3Config,
    scheduler: schedulerConfig,
    audit: {
      backend: (process.env['AUDIT_BACKEND'] as any) ?? (storageConfig.stateBackend === 'file' ? 'hybrid' : 'hybrid'),
    },
    server: {
      port: Number(process.env['PORT'] ?? 3000),
      ...overrides?.server,
    },
    features: overrides?.features ?? {},
    authz: overrides?.authz,
    cors: overrides?.cors ?? { origins: corsOriginsRaw.split(',').map(s => s.trim()).filter(Boolean) },
    rateLimit: {
      ...(rateLimitEnabled !== undefined ? { enabled: rateLimitEnabled !== 'false' } : {}),
      ...(rateLimitBypassIpsRaw !== undefined ? { bypassIps: rateLimitBypassIpsRaw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean) } : {}),
      ...(rateLimitBypassToken ? { bypassToken: rateLimitBypassToken } : {}),
    },
  };

  // ─── Validate against Zod schema ───
  const result = AppConfigSchema.safeParse(assembled);
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    console.error(`[config] Configuration validation failed:\n${issues}`);
    throw new Error('Configuration validation failed — check the errors above.');
  }

  return result.data as AppConfig;
}
