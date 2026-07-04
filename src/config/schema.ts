import { z } from 'zod';

// ─── Sub-schemas ───

const CredentialSchema = z.object({
  name: z.string(),
  type: z.enum(['aksk', 'bearer']).optional(),
  accessKeyId: z.string().optional(),
  accessKeySecret: z.string().optional(),
  token: z.string().optional(),
  defaultRegion: z.string().optional(),
  endpoint: z.string().optional(),
  bucket: z.string().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

const StorageConfigSchema = z.object({
  stateBackend: z.enum(['file', 'kv', 'do']).default('file'),
  queryBackend: z.enum(['file', 'd1', 'none']).default('none'),
  blobBackend: z.enum(['file', 'r2', 'none']).default('none'),
  connections: z.object({
    filePath: z.string().default('.data'),
    kvNamespace: z.string().default('KV_STORE'),
    doNamespace: z.string().default('ATOMIC_STORE_DO'),
    d1Binding: z.string().default('QUERY_DB'),
    r2Binding: z.string().default('BLOB_STORE'),
  }).default({ filePath: '.data', kvNamespace: 'KV_STORE', doNamespace: 'ATOMIC_STORE_DO', d1Binding: 'QUERY_DB', r2Binding: 'BLOB_STORE' }),
});

const LogConfigSchema = z.object({
  auditTier: z.enum(['auditable', 'best-effort']).default('best-effort'),
  defaultFacility: z.string().default('app'),
  storage: z.object({
    backend: z.string().default('filesystem'),
  }).default({ backend: 'filesystem' }),
});

const ProviderConfigSchema = z.object({
  region: z.string().default('cn-hangzhou'),
  accounts: z.array(CredentialSchema).default([]),
  defaultAccount: z.string().default('default'),
  cfApiToken: z.string().optional(),
  dns: z.enum(['cloudflare', 'stub']).default('stub'),
  metrics: z.enum(['alibaba', 'stub']).default('stub'),
});

const S3ConfigSchema = z.object({
  backend: z.enum(['minio', 'aws', 'alibaba', 'r2', 'cloudflare-r2', 'none']).default('none'),
  region: z.string().default('auto'),
  endpoint: z.string().optional(),
  accounts: z.array(CredentialSchema).default([]),
  defaultAccount: z.string().default('default'),
});

export const SchedulerAppConfigSchema = z.object({
  backend: z.enum(['worker', 'setInterval', 'do-alarm', 'manual', 'fake']).default('worker'),
  intervalMs: z.coerce.number().default(60_000),
  batchSize: z.coerce.number().default(0),
  callbackUrl: z.string().optional(),
});

const AuditConfigSchema = z.object({
  backend: z.enum(['kv', 'workers', 'r2', 'none', 'local', 'hybrid']).default('hybrid'),
});

// ═══════════════════════════════════════════════════════════════
// Root config schema
// ═══════════════════════════════════════════════════════════════

export const AppConfigSchema = z.object({
  storage: StorageConfigSchema.default({ stateBackend: 'file', queryBackend: 'none', blobBackend: 'none', connections: { filePath: '.data', kvNamespace: 'KV_STORE', doNamespace: 'ATOMIC_STORE_DO', d1Binding: 'QUERY_DB', r2Binding: 'BLOB_STORE' } }),
  log: LogConfigSchema.default({ auditTier: 'best-effort', defaultFacility: 'app', storage: { backend: 'filesystem' } }),
  provider: ProviderConfigSchema.default({ region: 'cn-hangzhou', accounts: [], defaultAccount: 'default', dns: 'cloudflare', metrics: 'alibaba' }),
  s3: S3ConfigSchema.default({ backend: 'none', region: 'auto', accounts: [], defaultAccount: 'default' }),
  scheduler: SchedulerAppConfigSchema.default({ backend: 'worker', intervalMs: 60_000, batchSize: 0 }),
  server: z.object({
    port: z.coerce.number().default(3000),
  }).default({ port: 3000 }),
  features: z.record(z.string(), z.boolean()).default({}),
  authz: z.object({ enabled: z.boolean() }).optional(),
  cors: z.object({
    origins: z.array(z.string()),
  }).optional(),
  audit: AuditConfigSchema.optional(),
  rateLimit: z.object({
    enabled: z.boolean().optional(),
    burst: z.number().optional(),
    intervalMs: z.number().optional(),
    bypassIps: z.array(z.string()).optional(),
    bypassToken: z.string().optional(),
  }).optional(),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
