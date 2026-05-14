export interface StorageConfig {
  stateBackend: 'do' | 'restate' | 'pg';
  queryBackend: 'd1' | 'turso' | 'pg';
  blobBackend: 'r2' | 's3';
  connections: {
    state?: Record<string, string>;
    query?: Record<string, string>;
    blob?: Record<string, string>;
  };
}

export const DEFAULT_STORAGE_CONFIG: StorageConfig = {
  stateBackend: 'pg',
  queryBackend: 'pg',
  blobBackend: 's3',
  connections: {},
} as const;
