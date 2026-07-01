import { z, ZodError } from 'zod';
import type { Credential } from './types.ts';

const { parse: parseJson } = JSON;

const rawAccountSchema = z.array(z.object({
  name: z.string().optional(),
  ak: z.string().optional(),
  sk: z.string().optional(),
  accessKeyId: z.string().optional(),
  accessKeySecret: z.string().optional(),
  secretAccessKey: z.string().optional(),
  region: z.string().optional(),
  endpoint: z.string().optional(),
  bucket: z.string().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
  registryCredentials: z.record(z.string(), z.unknown()).optional(),
}));
import { AuditTier } from '../core/audit/types.ts';
import { createRegionId } from '../core/region/types.ts';
import { AppConfigSchema } from './schema.ts';

export type { AppConfig } from './types.ts';

/**
 * Load configuration from environment variables with strict validation.
 * All backends and credentials are wired through env, never hardcoded.
 *
 * Overrides (used in tests/DI) are validated via AppConfigSchema.partial() before
 * merging — no type assertions. The fully assembled config is validated against
 * the full Zod schema at the end.
 */
export function loadConfig(overrides?: Record<string, unknown>): ReturnType<typeof AppConfigSchema.parse> {
  const overridesParsed = overrides ? AppConfigSchema.partial().parse(overrides) : {};

  const envAuditTier = process.env.LOG_AUDIT_TIER;
  const auditTier = envAuditTier === AuditTier.AUDITABLE ? AuditTier.AUDITABLE : AuditTier.BEST_EFFORT;

  const logConfig = {
    auditTier,
    defaultFacility: 'app',
    storage: {
      backend: process.env.LOG_STORAGE_BACKEND ?? 'filesystem',
    },
    ...overridesParsed.log,
  };

  const stateBackend = process.env.STATE_BACKEND ?? 'file';
  const queryBackend = process.env.QUERY_BACKEND ?? 'none';
  const blobBackend = process.env.BLOB_BACKEND ?? 'none';

  const storageConfig = {
    stateBackend,
    queryBackend,
    blobBackend,
    connections: {
      filePath: process.env.STATE_FILE_PATH ?? '.data',
      kvNamespace: process.env.KV_NAMESPACE ?? 'KV_STORE',
      doNamespace: process.env.DO_NAMESPACE ?? 'ATOMIC_STORE_DO',
      d1Binding: process.env.D1_BINDING ?? 'QUERY_DB',
      r2Binding: process.env.R2_BINDING ?? 'BLOB_STORE',
    },
    ...overridesParsed.storage,
  };

  function loadAccounts(): Credential[] {
    const json = process.env.ALIBABA_ACCOUNTS;
    if (json) {
      try {
        const parsed = rawAccountSchema.parse(parseJson(json));
        return parsed.map(a => ({
          name: a.name ?? 'default',
          accessKeyId: a.ak ?? a.accessKeyId ?? '',
          accessKeySecret: a.sk ?? a.accessKeySecret ?? '',
          defaultRegion: a.region,
          endpoint: a.endpoint,
          ...(a.extra ? { extra: a.extra } : {}),
          ...(a.registryCredentials ? { extra: { registryCredentials: a.registryCredentials } } : {}),
        }));
      } catch {
        console.debug("fall through to legacy");
      }
    }
    const legacyAk = process.env.ALIBABA_ACCESS_KEY_ID;
    const legacySk = process.env.ALIBABA_ACCESS_KEY_SECRET;
    if (legacyAk && legacySk) {
      return [{
        name: 'default',
        accessKeyId: legacyAk,
        accessKeySecret: legacySk,
        defaultRegion: process.env.ALIBABA_REGION ?? 'cn-hangzhou',
      }];
    }
    return [{ name: 'default', accessKeyId: '', accessKeySecret: '' }];
  }

  const providerConfig = {
    container: process.env.PROVIDER_CONTAINER ?? 'stub',
    region: createRegionId(process.env.ALIBABA_REGION ?? 'cn-hangzhou'),
    accounts: loadAccounts(),
    defaultAccount: process.env.ALIBABA_DEFAULT_ACCOUNT ?? 'default',
    cfApiToken: process.env.CF_API_TOKEN,
    dns: process.env.PROVIDER_DNS ?? 'stub',
    metrics: process.env.PROVIDER_METRICS ?? 'stub',
    ...overridesParsed.provider,
  };

  function loadS3Accounts(): Credential[] {
    const json = process.env.S3_ACCOUNTS;
    if (json) {
      try {
        const parsed = rawAccountSchema.parse(parseJson(json));
        return parsed.map(a => ({
          name: a.name ?? 'default',
          accessKeyId: a.ak ?? a.accessKeyId ?? '',
          accessKeySecret: a.sk ?? a.secretAccessKey ?? a.accessKeySecret ?? '',
          defaultRegion: a.region,
          endpoint: a.endpoint,
          bucket: a.bucket,
          ...(a.extra ? { extra: a.extra } : {}),
        }));
      } catch {
        console.debug("fall through");
      }
    }
    const legacyAk = process.env.S3_ACCESS_KEY_ID ?? process.env.MINIO_ACCESS_KEY ?? process.env.MINIO_ROOT_USER;
    const legacySk = process.env.S3_SECRET_ACCESS_KEY ?? process.env.MINIO_SECRET_KEY ?? process.env.MINIO_ROOT_PASSWORD;
    if (legacyAk && legacySk) {
      return [{
        name: 'default',
        accessKeyId: legacyAk,
        accessKeySecret: legacySk,
        defaultRegion: process.env.S3_REGION ?? 'us-east-1',
        endpoint: process.env.S3_ENDPOINT ?? process.env.MINIO_ENDPOINT,
      }];
    }
    return [{ name: 'default', accessKeyId: '', accessKeySecret: '' }];
  }

  const s3Config = {
    backend: process.env.S3_BACKEND ?? 'none',
    region: process.env.S3_REGION ?? 'auto',
    endpoint: process.env.S3_ENDPOINT ?? process.env.MINIO_ENDPOINT ?? undefined,
    accounts: loadS3Accounts(),
    defaultAccount: process.env.S3_DEFAULT_ACCOUNT ?? 'default',
    ...overridesParsed.s3,
  };

  const schedulerBackend = process.env.SCHEDULER_BACKEND ?? 'worker';

  const schedulerConfig = {
    backend: schedulerBackend,
    intervalMs: Number(process.env.SCHEDULER_INTERVAL_MS ?? 60000),
    batchSize: Number(process.env.SCHEDULER_BATCH_SIZE ?? 0),
    callbackUrl: process.env.WORKER_URL
      ? `${process.env.WORKER_URL.replace(/\/+$/, '')}/__scheduled`
      : undefined,
    ...overridesParsed.scheduler,
  };

  const corsOriginsRaw = process.env.CORS_ORIGINS ?? 'http://localhost:8086';

  const rateLimitEnabled = process.env.RATE_LIMIT_ENABLED;
  const rateLimitBypassIpsRaw = process.env.RATE_LIMIT_BYPASS_IPS;
  const rateLimitBypassToken = process.env.RATE_LIMIT_BYPASS_TOKEN ?? undefined;

  const assembled = {
    storage: storageConfig,
    log: logConfig,
    provider: providerConfig,
    s3: s3Config,
    scheduler: schedulerConfig,
    audit: {
      backend: process.env.AUDIT_BACKEND ?? (storageConfig.stateBackend === 'file' ? 'hybrid' : 'hybrid'),
    },
    server: {
      port: Number(process.env.PORT ?? 3000),
      ...overridesParsed.server,
    },
    features: overridesParsed.features ?? {},
    authz: overridesParsed.authz,
    cors: overridesParsed.cors ?? { origins: corsOriginsRaw.split(',').map(s => s.trim()).filter(Boolean) },
    rateLimit: {
      ...(rateLimitEnabled !== undefined ? { enabled: rateLimitEnabled !== 'false' } : {}),
      ...(rateLimitBypassIpsRaw !== undefined ? { bypassIps: rateLimitBypassIpsRaw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean) } : {}),
      ...(rateLimitBypassToken ? { bypassToken: rateLimitBypassToken } : {}),
    },
  };

  // ── Validate against Zod schema ──
  try {
    return AppConfigSchema.parse(assembled);
  } catch (e) {
    if (e instanceof ZodError) {
      const issues = e.issues
        .map(i => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n');
      console.error(`[config] Configuration validation failed:\n${issues}`);
      const wrapped = new Error('Configuration validation failed — check the errors above.');
      wrapped.cause = e;
      throw wrapped;
    }
    throw e;
  }
}
