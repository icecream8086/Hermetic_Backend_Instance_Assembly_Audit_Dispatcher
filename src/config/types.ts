import type { StorageConfig } from '../core/store/config.ts';
import type { AuditTier } from '../core/logger/interfaces.ts';

export interface LogConfig {
  auditTier: AuditTier;
  defaultFacility: string;
  storage: {
    backend: string;
  };
}

export interface AppConfig {
  storage: StorageConfig;
  log: LogConfig;
  server: {
    port: number;
  };
  features: Record<string, boolean>;
}
