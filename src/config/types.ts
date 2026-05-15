import type { StorageConfig } from '../core/store/config.ts';
import type { AuditTier } from '../core/logger/interfaces.ts';
import type { S3ProviderType } from '../core/provider/s3-types.ts';

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

export interface AppConfig {
  storage: StorageConfig;
  log: LogConfig;
  provider: ProviderConfig;
  s3: S3Config;
  server: {
    port: number;
  };
  features: Record<string, boolean>;
}
