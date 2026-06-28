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
  }).default({}),
});

const LogConfigSchema = z.object({
  auditTier: z.enum(['auditable', 'best-effort']).default('best-effort'),
  defaultFacility: z.string().default('app'),
  storage: z.object({
    backend: z.string().default('filesystem'),
  }).default({}),
});

const ProviderConfigSchema = z.object({
  container: z.enum(['alibaba', 'podman', 'stub']).default('stub'),
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
  storage: StorageConfigSchema.default({}),
  log: LogConfigSchema.default({}),
  provider: ProviderConfigSchema.default({}),
  s3: S3ConfigSchema.default({}),
  scheduler: SchedulerAppConfigSchema.default({}),
  server: z.object({
    port: z.coerce.number().default(3000),
  }).default({}),
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
