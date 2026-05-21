export interface StorageConfig {
  stateBackend: 'kv' | 'do' | 'file';
  queryBackend: 'd1' | 'file' | 'none';
  blobBackend: 'r2' | 'file' | 'none';
  /** Seconds until cache entries expire in the KV backend (read-trough TTL). */
  cacheTtlSeconds?: number;
  connections: {
    /** CF KV namespace binding name (stateBackend='kv') */
    kvNamespace?: string;
    /** CF DO namespace binding name (stateBackend='do') */
    doNamespace?: string;
    /** CF D1 database binding name (queryBackend='d1') */
    d1Binding?: string;
    /** CF R2 bucket binding name (blobBackend='r2') */
    r2Binding?: string;
    /** Local file path (stateBackend='file', queryBackend='file', blobBackend='file') */
    filePath?: string;
    state?: Record<string, string>;
    query?: Record<string, string>;
    blob?: Record<string, string>;
  };
}

export const DEFAULT_STORAGE_CONFIG: StorageConfig = {
  stateBackend: 'file',
  queryBackend: 'none',
  blobBackend: 'none',
  connections: {},
} as const;
