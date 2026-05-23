import type { StorageConfig } from '../core/store/config.ts';
import type { AuditTier } from '../core/logger/interfaces.ts';
import type { S3ProviderType } from '../core/provider/s3-types.ts';
import type { SchedulerBackendType } from '../core/scheduler/interfaces.ts';

export interface LogConfig {
  auditTier: AuditTier;
  defaultFacility: string;
  storage: {
    backend: string;
  };
}

export interface ProviderConfig {
  /** Container provider backend type. */
  container: 'alibaba' | 'stub';
  /** DNS provider backend type. */
  dns: 'cloudflare' | 'stub';
  /** Metrics provider backend type. */
  metrics: 'alibaba' | 'stub';
}

export interface S3Config {
  /** S3-compatible storage backend type. */
  backend: S3ProviderType | 'none';
  /** Region for the storage backend (not used for cloudflare-r2). */
  region: string;
}

export interface SchedulerAppConfig {
  /** Timer backend type, driven by `SCHEDULER_BACKEND` env var. */
  backend: SchedulerBackendType;
  /** Tick interval in ms, driven by `SCHEDULER_INTERVAL_MS` env var. */
  intervalMs: number;
  /** Events per tick. 0 = drain all, 1 = round-robin. */
  batchSize: number;
  /**
   * Worker URL for DO alarm callback, driven by `WORKER_URL` env var.
   * DO alarm fires → `fetch(WORKER_URL + "/__scheduled")` → loop.triggerTick().
   * In dev: `http://localhost:3000`.
   */
  callbackUrl?: string | undefined;
}

export interface AuthzConfig {
  enabled: boolean;
}

export interface AppConfig {
  storage: StorageConfig;
  log: LogConfig;
  provider: ProviderConfig;
  s3: S3Config;
  scheduler: SchedulerAppConfig;
  server: {
    port: number;
  };
  features: Record<string, boolean>;
  authz?: AuthzConfig | undefined;
}
