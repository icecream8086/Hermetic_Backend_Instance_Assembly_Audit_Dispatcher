# V3 S3 预签名控制面 — 开发日志

> **基线**: 2026-07-04, V2 已实现 (`SPEC/security-resource-presigned-spec.md`)
> **目标**: 将 SecurityResource 从"URL 缓存"改造为"Worker 控制面 + 按需 JWT 签名"
> **规范**: `SPEC/s3-presigned-control-plane.md`

---

## 前置条件

- [ ] 已阅读 `SPEC/s3-presigned-control-plane.md`
- [ ] 已理解 V2 的四个缺陷（PUT placeholder bug、无 getUrl、无多对象读取、URL 不可吊销）
- [ ] `npm run typecheck` 当前通过
- [ ] `npm run lint` 当前通过

## 依赖

- Web Crypto API (`crypto.subtle`) — Cloudflare Workers 和 Node.js 19+ 均内置
- 无需安装新 npm 包

---

## Phase 1 — 删除死代码

> **原则**: 先删不再需要的东西，后续阶段不会引用它们，编译器帮我们验证没有 dangling reference。

### Step 1.1: 删除 `src/core/events/security-refresh.ts`

**原因**: V3 不刷新 JWT，URL 按需签发。事件循环 tick 中不再有 presigned URL 续期逻辑。

**操作**: 直接删除文件。不是"清空内容"，是删除整个文件（`rm` 或 IDE delete）。

### Step 1.2: 删除 `app.ts` 中的 `registerSecurityRefresh` 调用

**文件**: `src/core/app.ts`

**删除范围**: 行 170–182（从 `// 5b4.` 注释到 `});` 闭括号）。

**当前代码**:
```typescript
  // 5b4. SecurityResource 自动刷新 — 每 5 分钟扫描并续期即将过期的 presigned URL
  const securityService = new SecurityResourceService(stores.atomic, audit);
  registerSecurityRefresh({
    securityService,
    // TODO: resolve per-bucket S3 provider when multiple storage backends are supported
    s3Resolver: (_bucketId: string): Promise<IS3Provider> => {
      const s3 = providers.s3Account();
      if (!s3) throw new AppError(500, 'INTERNAL_ERROR', 'No S3 provider available for security resource refresh');
      return Promise.resolve(s3);
    },
    eventBus,
    eventLoop,
  });
```

**删除全部 13 行，不留空行**。后续 `// 5c.` 段落紧接 `// 5b3.` 段落之后。

### Step 1.3: 删除 `app.ts` 中不再使用的 import

**文件**: `src/core/app.ts`

删除行:
```typescript
import { registerSecurityRefresh } from './events/security-refresh.ts';  // 行 43
```

删除行 (如果 SecurityResourceService 不再在 app.ts 中使用——检查 Phase 1 后是否还有引用):
```typescript
import { SecurityResourceService } from './security/service.ts';  // 行 45
```

**注意**: `SecurityResourceService` 在 Phase 4 重写后会重新引入（`featureDeps` 中通过 `s3ProviderResolver` 间接使用），但 Phase 1 结束时可以先删。Phase 4 再加回来。

### Step 1.4: 删除 `SecurityResourceRef` 类型

**文件**: `src/features/sandbox/types.ts`

**删除范围**: 行 434–448，完整的 `SecurityResourceRef` 接口定义。

**当前代码**:
```typescript
export interface SecurityResourceRef {
  /** SecurityResource.id。 */
  readonly resourceId: string;
  /** SecurityResource.name，用作挂载文件名。 */
  readonly resourceName: string;
  /** 当前有效的 PresignedUrlSet（sandbox 创建时的快照）。 */
  readonly value: {
    readonly putUrl: string;
    readonly listUrl: string;
    readonly endpoint: string;
    readonly bucket: string;
    readonly region: string;
    readonly expiresAt: string;
  };
}
```

**删除整个接口**。V3 不再把 URL 快照放在 sandbox input 里。

### Step 1.5: 删除 `PresignedUrlSet` 类型

**文件**: `src/core/security/types.ts`

**删除范围**: 行 22–35，完整的 `PresignedUrlSet` 接口定义。

**当前代码**:
```typescript
export interface PresignedUrlSet {
  readonly putUrl: string;
  readonly listUrl: string;
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly expiresAt: string;
}
```

### Step 1.6: 验证 Phase 1

```bash
npm run typecheck  # 预期失败 —— 后续引用 PresignedUrlSet/SecurityResourceRef 的代码会报错
npm run lint       # 预期失败
```

**确认编译错误来自**:
- `applicator.ts` — import `SecurityResourceRef`
- `sandbox.service.ts` — `toPodSpec()` 中引用 `sr.resourceName`, `sr.value`
- `sandbox/types.ts` — `CreateSandboxInput.securityResources` 类型引用 `SecurityResourceRef`
- `security/service.ts` — `provision()` 中引用 `PresignedUrlSet`

这些错误在 Phase 2–7 逐步修复。如果没有出现这些错误，说明删除不完整——回退检查 `git diff`。

---

## Phase 2 — 重写类型层

> **原则**: 类型是唯一信源。所有后续阶段依赖这一步的正确输出。

### Step 2.1: 重写 `src/core/security/types.ts`

**目标**: 完整替换文件内容。保留 `SecurityResourceId` 和 `SecurityResourceStatus`。删除 `PresignedUrlSet`、`validDuration`、`refreshThreshold`、`value`。新增 `StorageAccessEntry`、`tokenTtl`、`presignedUrlTtl`、`accessPolicy`。

**新文件内容**:
```typescript
import { z } from 'zod';
import type { InstanceId } from '../region/instance.ts';

// ─── Brand types ───

const securityResourceIdSchema = z.string().min(1).brand('SecurityResourceId');
export type SecurityResourceId = z.infer<typeof securityResourceIdSchema>;

export function createSecurityResourceId(raw: string): SecurityResourceId {
  return securityResourceIdSchema.parse(raw);
}

// ─── Status ───

export enum SecurityResourceStatus {
  Active = 'Active',
  Expired = 'Expired',
  Revoked = 'Revoked',
}

// ─── Storage access policy ───

export interface StorageAccessEntry {
  /** Allowed key prefix. Empty string = full bucket. */
  readonly prefix: string;
  /** Allowed operations on this prefix. */
  readonly permissions: readonly ('read' | 'write' | 'list')[];
}

// ─── Entity ───

export interface SecurityResource {
  readonly id: SecurityResourceId;
  readonly name: string;
  /** Associated S3 bucket ID (RegionBucket.id). */
  readonly bucketId: string;
  /** Compute instance ID for provider resolution. */
  readonly instanceId: InstanceId;
  /** JWT token lifetime in seconds. Default 3600 (1h). */
  readonly tokenTtl: number;
  /** On-demand presigned URL lifetime in seconds. Default 300 (5min). */
  readonly presignedUrlTtl: number;
  /** Bucket + key prefix whitelist. */
  readonly accessPolicy: readonly StorageAccessEntry[];
  readonly status: SecurityResourceStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ─── CRUD inputs ───

export interface CreateSecurityResourceInput {
  readonly name: string;
  readonly bucketId: string;
  readonly instanceId: InstanceId;
  readonly tokenTtl?: number | undefined;
  readonly presignedUrlTtl?: number | undefined;
  readonly accessPolicy?: readonly StorageAccessEntry[] | undefined;
}

export interface UpdateSecurityResourceInput {
  readonly name?: string | undefined;
  readonly tokenTtl?: number | undefined;
  readonly presignedUrlTtl?: number | undefined;
  readonly accessPolicy?: readonly StorageAccessEntry[] | undefined;
  readonly status?: SecurityResourceStatus | undefined;
}

// ─── JWT Claims（签发时使用，不持久化） ───

export interface S3AccessTokenClaims {
  readonly jti: string;
  readonly iss: string;
  readonly sub: string;
  readonly iat: number;
  readonly exp: number;
  readonly grants: readonly {
    readonly bucket: string;
    readonly prefix: string;
    readonly permissions: readonly ('read' | 'write' | 'list')[];
  }[];
}
```

### Step 2.2: 更新 `src/features/sandbox/types.ts` — 替换 `securityResources` 类型

**当前代码** (行 ~395):
```typescript
  /** 引用的 SecurityResource 列表。applicator 解析后填充，注入容器时使用。 */
  readonly securityResources?: readonly SecurityResourceRef[] | undefined;
```

**替换为**:
```typescript
  /** S3 storage access token for sandbox. Issued at provision time.
   *  Injected as /run/secrets/s3/token in the container. */
  readonly storageAccess?: SandboxStorageAccess | undefined;
```

**在文件末尾新增**（`SecurityResourceRef` 原来的位置）:
```typescript
export interface SandboxStorageAccess {
  /** JWT token with S3 access grants. */
  readonly token: string;
  /** Expiration time (ISO 8601). */
  readonly expiresAt: string;
}
```

**删除 import 中的 `SecurityResourceRef`** (行 2):
```typescript
// 删除 SecurityResourceRef，添加 SandboxStorageAccess
import type { CreateSandboxInput, Volume, VolumeMount, SandboxNetworkConfig, SandboxStorageAccess } from '../sandbox/types.ts';
```

### Step 2.3: 验证 Phase 2

```bash
npm run typecheck
```

**预期错误**:
- `security/service.ts` — 引用已删除的 `PresignedUrlSet`、`validDuration`、`refreshThreshold`、`value`
- `security/response-schema.ts` — 引用 `PresignedUrlInfoSchema`（需要更新）
- `security/handler.ts` — 引用已变更的 `CreateSecurityResourceInput` 字段
- `template/applicator.ts` — 引用已删除的 `SecurityResourceRef`
- `sandbox/sandbox.service.ts` — 引用已删除的 `SecurityResourceRef`

**如果没有这些错误 → 去 Phase 3 继续。**

---

## Phase 3 — JWT 基础设施

> **原则**: JWT 签发和验证是独立的纯函数，不依赖任何其他 V3 变更。先建好轮子。

### Step 3.1: 新建 `src/core/security/jwt.ts`

**用途**: HMAC-SHA256 JWT 签发和验证。使用 Web Crypto API（Cloudflare Workers + Node.js 均内置）。

**文件内容**:
```typescript
import type { S3AccessTokenClaims } from './types.ts';

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

// ─── Base64url（导出，供 service.ts 编解码 JWT secret） ───

export function base64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    str.length + ((4 - (str.length % 4)) % 4), '=',
  );
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ─── Crypto key ───

async function importKey(secret: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign', 'verify'],
  );
}

// ─── Sign ───

export async function signToken(
  claims: S3AccessTokenClaims,
  secret: Uint8Array,
): Promise<string> {
  const header = base64url(ENCODER.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = base64url(ENCODER.encode(JSON.stringify(claims)));
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, ENCODER.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64url(sig)}`;
}

// ─── Verify ───

export interface JwtVerifyResult {
  valid: true;
  claims: S3AccessTokenClaims;
}

export interface JwtVerifyError {
  valid: false;
  reason: string;
}

export async function verifyToken(
  token: string,
  secret: Uint8Array,
): Promise<JwtVerifyResult | JwtVerifyError> {
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'Malformed token' };

  const [headerB64, payloadB64, sigB64] = parts;
  const key = await importKey(secret);
  const sigBytes = base64urlDecode(sigB64!);

  const valid = await crypto.subtle.verify(
    'HMAC', key, sigBytes,
    ENCODER.encode(`${headerB64}.${payloadB64}`),
  );
  if (!valid) return { valid: false, reason: 'Invalid signature' };

  const payloadJson = DECODER.decode(base64urlDecode(payloadB64!));
  const claims = JSON.parse(payloadJson) as S3AccessTokenClaims;

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp <= now) return { valid: false, reason: 'Token expired' };

  return { valid: true, claims };
}
```

**关键技术点**:
- 使用 `crypto.subtle` 而非 `jose` npm 包——零依赖，Cloudflare Workers 原生支持
- `base64url` 手写实现（`btoa`/`atob` 在 Workers 和 Node 均可用）
- **`base64url` 和 `base64urlDecode` 必须导出**——`service.ts` 和 handler 需要用它们序列化/反序列化 JWT secret key
- `verifyToken` 返回 tagged union `{valid, claims}` 而非 throw——调用方类型安全处理两种路径

### Step 3.2: 新建 `src/core/security/middleware.ts`

**用途**: Hono 中间件，从 `Authorization: Bearer <jwt>` 提取并验证 JWT。复用于 presign / batch-presign / list 三个端点。

**文件内容**:
```typescript
import type { Context, Next } from 'hono';
import type { IAtomicStore } from '../store/interfaces.ts';
import type { S3AccessTokenClaims } from './types.ts';
import { verifyToken, base64urlDecode } from './jwt.ts';

const JWT_SECRET_KEY = '_sys:jwt-secret';

export interface JwtAuthContext {
  s3Access: S3AccessTokenClaims;
  error: null;
}

export interface JwtAuthError {
  s3Access: null;
  error: { status: 401 | 403; code: string; message: string };
}

export type JwtAuthResult = JwtAuthContext | JwtAuthError;

/**
 * Hono middleware. Validates JWT from Authorization header.
 * On success: sets c.var.s3Access = claims.
 * On failure: short-circuits with 401/403 JSON response.
 */
export async function jwtAuth(
  c: Context<{ Variables: { s3Access?: S3AccessTokenClaims | undefined } }>,
  next: Next,
  atomic: IAtomicStore,
): Promise<void> {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) {
    c.status(401);
    c.res = new Response(JSON.stringify({ error: 'UNAUTHORIZED', message: 'Missing or malformed Authorization header' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
    return;
  }
  const token = auth.slice(7);

  const secretEntry = await atomic.get<string>(JWT_SECRET_KEY);
  if (!secretEntry?.value) {
    c.status(500);
    c.res = new Response(JSON.stringify({ error: 'INTERNAL_ERROR', message: 'JWT secret not configured' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
    return;
  }
  const secret = base64urlDecode(secretEntry.value);

  const result = await verifyToken(token, secret);
  if (!result.valid) {
    c.status(401);
    c.res = new Response(JSON.stringify({ error: 'UNAUTHORIZED', message: result.reason }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
    return;
  }

  c.set('s3Access', result.claims);
  await next();
}
```

### Step 3.3: 验证 Phase 3

```bash
npm run typecheck
```

**预期**: JWT 模块是独立新增文件，不影响现有编译。除非 types.ts 的 `S3AccessTokenClaims` 有语法错误。验证通过后进入 Phase 4。

---

## Phase 4 — 重写 SecurityResourceService

> **原则**: `provision()` 不再生成 URL。新增 `issueToken()`。CRUD 方法保留但适配新字段。

### Step 4.1: 重写 `src/core/security/service.ts`

**文件内容**:
```typescript
import type { IAtomicStore } from '../store/interfaces.ts';
import type { IAuditWriter } from '../audit/types.ts';
import type {
  SecurityResource, SecurityResourceId, CreateSecurityResourceInput,
} from './types.ts';
import { SecurityResourceStatus } from './types.ts';
import { createSecurityResourceId } from './types.ts';
import type { S3AccessTokenClaims } from './types.ts';
import { signToken, base64url, base64urlDecode } from './jwt.ts';

const PREFIX = 'security:';
const INDEX_KEY = 'security:ids';
const JWT_SECRET_KEY = '_sys:jwt-secret';

async function getJwtSecret(atomic: IAtomicStore): Promise<Uint8Array> {
  const entry = await atomic.get<string>(JWT_SECRET_KEY);
  if (entry?.value) {
    return base64urlDecode(entry.value);
  }
  // Auto-generate on first use
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  await atomic.set(JWT_SECRET_KEY, base64url(bytes.buffer), null);
  return bytes;
}

export class SecurityResourceService {
  public constructor(
    private readonly atomic: IAtomicStore,
    _audit: IAuditWriter,
  ) {}

  // ── Provision (policy entity, not URLs) ──

  public async provision(input: CreateSecurityResourceInput): Promise<SecurityResource> {
    const now = Date.now();
    const id = createSecurityResourceId(crypto.randomUUID());
    const resource: SecurityResource = {
      id, name: input.name,
      bucketId: input.bucketId,
      instanceId: input.instanceId,
      tokenTtl: input.tokenTtl ?? 3600,
      presignedUrlTtl: input.presignedUrlTtl ?? 300,
      accessPolicy: input.accessPolicy ?? [{ prefix: '', permissions: ['read', 'write', 'list'] }],
      status: SecurityResourceStatus.Active,
      createdAt: now, updatedAt: now,
    };

    await this.atomic.set(`${PREFIX}${id}`, resource, null);
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    await this.atomic.set(INDEX_KEY, [...(idx?.value ?? []), id], idx?.version ?? null);
    return resource;
  }

  // ── Issue JWT for sandbox ──

  /**
   * Issue a JWT token encoding the access policy from all given SecurityResources.
   * Call at sandbox provision time. Token is injected into the container.
   */
  public async issueToken(
    resourceNames: readonly string[],
    sandboxId: string,
  ): Promise<{ token: string; expiresAt: string }> {
    const resources = await Promise.all(
      resourceNames.map(name => this.getByName(name)),
    );
    const found = resources.filter((r): r is SecurityResource => r !== null);
    if (found.length !== resourceNames.length) {
      const missing = resourceNames.filter(
        name => !found.some(r => r.name === name),
      );
      throw new Error(`SecurityResource(s) not found: ${missing.join(', ')}`);
    }

    const now = Math.floor(Date.now() / 1000);
    const ttl = Math.min(...found.map(r => r.tokenTtl));

    const claims: S3AccessTokenClaims = {
      jti: crypto.randomUUID(),
      iss: 'hbi-aad',
      sub: sandboxId,
      iat: now,
      exp: now + ttl,
      grants: found.flatMap(r =>
        r.accessPolicy.map(entry => ({
          bucket: r.bucketId,
          prefix: entry.prefix,
          permissions: entry.permissions,
        })),
      ),
    };

    const secret = await getJwtSecret(this.atomic);
    const token = await signToken(claims, secret);
    return {
      token,
      expiresAt: new Date((now + ttl) * 1000).toISOString(),
    };
  }

  // ── Read ──

  public async getById(id: SecurityResourceId): Promise<SecurityResource | null> {
    const entry = await this.atomic.get<SecurityResource>(`${PREFIX}${id}`);
    return entry?.value ?? null;
  }

  public async getByName(name: string): Promise<SecurityResource | null> {
    const all = await this.list();
    return all.find(r => r.name === name) ?? null;
  }

  public async list(status?: SecurityResourceStatus): Promise<SecurityResource[]> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    if (!idx?.value.length) return [];
    const entries = await Promise.all(
      idx.value.map(id => this.atomic.get<SecurityResource>(`${PREFIX}${id}`)),
    );
    const resources: SecurityResource[] = [];
    for (const e of entries) {
      if (e !== null) resources.push(e.value);
    }
    return status ? resources.filter(r => r.status === status) : resources;
  }

  // ── Status management ──

  public async markExpired(id: SecurityResourceId): Promise<void> {
    const entry = await this.atomic.get<SecurityResource>(`${PREFIX}${id}`);
    if (entry?.value) {
      await this.atomic.set(`${PREFIX}${id}`, {
        ...entry.value, status: SecurityResourceStatus.Expired, updatedAt: Date.now(),
      }, entry.version);
    }
  }

  public async revoke(id: SecurityResourceId): Promise<void> {
    const entry = await this.atomic.get<SecurityResource>(`${PREFIX}${id}`);
    if (entry?.value) {
      await this.atomic.set(`${PREFIX}${id}`, {
        ...entry.value, status: SecurityResourceStatus.Revoked, updatedAt: Date.now(),
      }, entry.version);
    }
  }

  public async delete(id: SecurityResourceId): Promise<void> {
    const entry = await this.atomic.get<SecurityResource>(`${PREFIX}${id}`);
    if (entry) {
      await this.atomic.set(`${PREFIX}${id}`, null, entry.version);
      const idx = await this.atomic.get<string[]>(INDEX_KEY);
      if (idx) {
        await this.atomic.set(INDEX_KEY, idx.value.filter(i => i !== id), idx.version);
      }
    }
  }
}
```

**关键变更 vs V2**:
- `provision()` 不再接受 `s3Provider/bucketName/endpoint/region` 参数——不再签发 URL
- 新增 `issueToken(resourceNames, sandboxId)` —— 查多个 SecurityResource 策略，合成为 JWT
- 删除 `refresh()` —— JWT 不刷新
- 删除 `checkValidity()` —— applicator 不再检查 URL 有效期
- `getJwtSecret()` 自举——首次调用自动生成随机 secret 写入 KV

### Step 4.2: 验证 Phase 4

```bash
npm run typecheck
```

**预期错误**: 仍然有——handler 中的 `CreateSecurityResourceSchema`、response-schema、applicator 对 `SecurityResourceRef` 的引用。这些在 Phase 5–7 修复。

---

## Phase 5 — API 端点

> **原则**: CRUD 端点保留，新增三个容器端点（presign / batch-presign / list）。

### Step 5.1: 更新 `src/features/security/schema.ts`

**文件内容**:
```typescript
import { z } from 'zod';

// ─── CRUD ───

export const CreateSecurityResourceSchema = z.object({
  name: z.string().min(1).max(200),
  bucketId: z.string().min(1),
  instanceId: z.string().min(1),
  tokenTtl: z.number().int().positive().optional(),
  presignedUrlTtl: z.number().int().positive().optional(),
  accessPolicy: z.array(z.object({
    prefix: z.string(),
    permissions: z.array(z.enum(['read', 'write', 'list'])),
  })).optional(),
});

export const UpdateSecurityResourceSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  tokenTtl: z.number().int().positive().optional(),
  presignedUrlTtl: z.number().int().positive().optional(),
  accessPolicy: z.array(z.object({
    prefix: z.string(),
    permissions: z.array(z.enum(['read', 'write', 'list'])),
  })).optional(),
});

// ─── Container-facing ───

export const PresignQuerySchema = z.object({
  bucket: z.string().min(1),
  key: z.string().min(1),
  method: z.enum(['GET', 'PUT']),
});

export const BatchPresignSchema = z.object({
  files: z.array(z.object({
    bucket: z.string().min(1),
    key: z.string().min(1),
    method: z.enum(['GET', 'PUT']),
  })).min(1).max(100),
});

export const ListQuerySchema = z.object({
  bucket: z.string().min(1),
  prefix: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  continuationToken: z.string().optional(),
});
```

### Step 5.2: 更新 `src/features/security/response-schema.ts`

**文件内容**:
```typescript
import { z } from 'zod';
import { SecurityResourceStatus } from '../../core/security/types.ts';

export const StorageAccessEntrySchema = z.object({
  prefix: z.string(),
  permissions: z.array(z.enum(['read', 'write', 'list'])),
});

export const SecurityResourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  bucketId: z.string(),
  instanceId: z.string(),
  tokenTtl: z.number(),
  presignedUrlTtl: z.number(),
  accessPolicy: z.array(StorageAccessEntrySchema),
  status: z.enum([SecurityResourceStatus.Active, SecurityResourceStatus.Expired, SecurityResourceStatus.Revoked]),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const SecurityResourceListResponseSchema = z.object({
  items: z.array(SecurityResourceSchema).readonly(),
});

// ─── Container-facing response schemas ───

export const PresignResponseSchema = z.object({
  url: z.string(),
  bucket: z.string(),
  key: z.string(),
  expiresAt: z.string(),
});

export const BatchPresignResponseSchema = z.object({
  urls: z.array(z.object({
    bucket: z.string(),
    key: z.string(),
    url: z.string(),
    expiresAt: z.string(),
  })),
});

export const ListResponseSchema = z.object({
  files: z.array(z.object({
    key: z.string(),
    size: z.number(),
    lastModified: z.string().optional(),
  })),
  nextContinuationToken: z.string().optional(),
  isTruncated: z.boolean(),
});
```

### Step 5.3: 重写 `src/features/security/handler.ts`

**文件内容**:
```typescript
import { z } from 'zod';
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { AppError } from '../../core/types.ts';
import type { AppContext } from '../../core/deps.ts';
import type { SecurityResourceService } from '../../core/security/service.ts';
import { createSecurityResourceId } from '../../core/security/types.ts';
import { SecurityResourceStatus } from '../../core/security/types.ts';
import { createInstanceId } from '../../core/region/instance.ts';
import type { IS3Provider } from '../../core/provider/s3.ts';
import { CreateSecurityResourceSchema, PresignQuerySchema, BatchPresignSchema, ListQuerySchema } from './schema.ts';
import { ok } from '../../core/response.ts';
import { OkResponse } from '../../core/http-docs/response-schema.ts';
import {
  SecurityResourceSchema, SecurityResourceListResponseSchema,
  PresignResponseSchema, BatchPresignResponseSchema, ListResponseSchema,
} from './response-schema.ts';
import { jwtAuth } from '../../core/security/middleware.ts';

const ADMIN_ROLES = new Set(['root', 'Operator', 'wheel']);

function isRoot<E extends { Variables: { currentUser?: { role?: string } } }>(c: Context<E>): void {
  const role = z.string().optional().parse(c.var.currentUser?.role);
  if (!role || !ADMIN_ROLES.has(role)) {
    throw new AppError(403, 'FORBIDDEN', 'Admin access required');
  }
}

export interface SecurityRouterDeps {
  securityService: SecurityResourceService;
  s3ProviderResolver: (bucketId: string) => Promise<{ provider: IS3Provider; bucket: { name: string; endpoint: string; region: string } }>;
}

export function createSecurityRouter(deps: SecurityRouterDeps): OpenAPIHono<{ Variables: AppContext }> {
  const { securityService, s3ProviderResolver } = deps;
  const app = new OpenAPIHono<{ Variables: AppContext }>();

  // ══════════════════════════════════════════════════
  // Admin CRUD endpoints
  // ══════════════════════════════════════════════════

  // ── POST /api/security ──
  app.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['security'],
      summary: 'Create SecurityResource (storage access policy)',
      request: { body: { content: { 'application/json': { schema: CreateSecurityResourceSchema } } } },
      responses: { 201: { description: 'Created', content: { 'application/json': { schema: OkResponse(SecurityResourceSchema) } } } },
    }),
    async (c) => {
      isRoot(c);
      // eslint-disable-next-line local-rules/enforce-decode-layer -- .parse(AwaitExpr) — rule only checks immediate parent, not grandparent
      const body = CreateSecurityResourceSchema.parse(await c.req.json());
      const resource = await securityService.provision({
        name: body.name,
        bucketId: body.bucketId,
        instanceId: createInstanceId(body.instanceId),
        tokenTtl: body.tokenTtl,
        presignedUrlTtl: body.presignedUrlTtl,
        accessPolicy: body.accessPolicy,
      });
      return c.json(ok(resource), 201);
    },
  );

  // ── GET /api/security ──
  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['security'],
      summary: 'List all SecurityResources',
      responses: { 200: { description: 'List', content: { 'application/json': { schema: OkResponse(SecurityResourceListResponseSchema) } } } },
    }),
    async (c) => {
      const statusRaw = c.req.query('status');
      const status = statusRaw ? z.enum(['Active', 'Expired', 'Revoked']).parse(statusRaw) : undefined;
      const resources = await securityService.list(
        status === 'Active' ? SecurityResourceStatus.Active
          : status === 'Expired' ? SecurityResourceStatus.Expired
          : status === 'Revoked' ? SecurityResourceStatus.Revoked
          : undefined,
      );
      return c.json(ok({ items: resources }));
    },
  );

  // ── GET /api/security/{id} ──
  app.openapi(
    createRoute({
      method: 'get',
      path: '/{id}',
      tags: ['security'],
      summary: 'Get SecurityResource by ID',
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: { description: 'Resource', content: { 'application/json': { schema: OkResponse(SecurityResourceSchema) } } } },
    }),
    async (c) => {
      const id = createSecurityResourceId(c.req.param('id'));
      const resource = await securityService.getById(id);
      if (!resource) throw new AppError(404, 'NOT_FOUND', 'SecurityResource not found');
      return c.json(ok(resource));
    },
  );

  // ── POST /api/security/{id}/revoke ──
  app.openapi(
    createRoute({
      method: 'post',
      path: '/{id}/revoke',
      tags: ['security'],
      summary: 'Revoke SecurityResource',
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: { description: 'Revoked', content: { 'application/json': { schema: OkResponse(z.null()) } } } },
    }),
    async (c) => {
      isRoot(c);
      const id = createSecurityResourceId(c.req.param('id'));
      await securityService.revoke(id);
      return c.json(ok(null));
    },
  );

  // ── DELETE /api/security/{id} ──
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/{id}',
      tags: ['security'],
      summary: 'Delete SecurityResource',
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: OkResponse(z.null()) } } } },
    }),
    async (c) => {
      isRoot(c);
      const id = createSecurityResourceId(c.req.param('id'));
      await securityService.delete(id);
      return c.json(ok(null));
    },
  );

  // ══════════════════════════════════════════════════
  // Container-facing endpoints (JWT auth)
  // ══════════════════════════════════════════════════

  // ── GET /api/security/presign ──
  app.get('/presign', async (c) => {
    const atomic = c.var.stores.atomic;
    // JWT auth
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      throw new AppError(401, 'UNAUTHORIZED', 'Missing or malformed Authorization header');
    }
    // Verify inline — Hono OpenAPI middleware 不适用，手动调用
    const { verifyToken, base64urlDecode } = await import('../../core/security/jwt.ts');
    const secretEntry = await atomic.get<string>('_sys:jwt-secret');
    if (!secretEntry?.value) throw new AppError(500, 'INTERNAL_ERROR', 'JWT secret not configured');
    const secret = base64urlDecode(secretEntry.value);
    const result = await verifyToken(authHeader.slice(7), secret);
    if (!result.valid) throw new AppError(401, 'UNAUTHORIZED', result.reason);

    const claims = result.claims;
    const query = PresignQuerySchema.parse({
      bucket: c.req.query('bucket'),
      key: c.req.query('key'),
      method: c.req.query('method'),
    });

    // Authorize: check grant covers (bucket, key, method)
    const grant = claims.grants.find(g => g.bucket === query.bucket);
    if (!grant) throw new AppError(403, 'FORBIDDEN', `No access to bucket "${query.bucket}"`);
    if (!query.key.startsWith(grant.prefix)) {
      throw new AppError(403, 'FORBIDDEN', `Key "${query.key}" not under allowed prefix "${grant.prefix}"`);
    }
    const requiredPerm = query.method === 'GET' ? 'read' : 'write';
    if (!grant.permissions.includes(requiredPerm)) {
      throw new AppError(403, 'FORBIDDEN', `No "${requiredPerm}" permission on "${query.bucket}"`);
    }

    // Find resource to get presignedUrlTtl
    const resource = await securityService.getByName(query.bucket);
    const urlTtl = resource?.presignedUrlTtl ?? 300;

    const { provider } = await s3ProviderResolver(query.bucket);
    const url = query.method === 'GET'
      ? await provider.getPresignedUrl(query.bucket, query.key, urlTtl)
      : await provider.putPresignedUrl(query.bucket, query.key, urlTtl);

    const expiresAt = new Date(Date.now() + urlTtl * 1000).toISOString();
    return c.json(ok({ url, bucket: query.bucket, key: query.key, expiresAt }));
  });

  // ── POST /api/security/batch-presign ──
  app.post('/batch-presign', async (c) => {
    const atomic = c.var.stores.atomic;
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      throw new AppError(401, 'UNAUTHORIZED', 'Missing or malformed Authorization header');
    }
    const { verifyToken, base64urlDecode } = await import('../../core/security/jwt.ts');
    const secretEntry = await atomic.get<string>('_sys:jwt-secret');
    if (!secretEntry?.value) throw new AppError(500, 'INTERNAL_ERROR', 'JWT secret not configured');
    const secret = base64urlDecode(secretEntry.value);
    const result = await verifyToken(authHeader.slice(7), secret);
    if (!result.valid) throw new AppError(401, 'UNAUTHORIZED', result.reason);

    const claims = result.claims;
    // eslint-disable-next-line local-rules/enforce-decode-layer
    const body = BatchPresignSchema.parse(await c.req.json());

    // Authorize each file
    for (const f of body.files) {
      const grant = claims.grants.find(g => g.bucket === f.bucket);
      if (!grant) throw new AppError(403, 'FORBIDDEN', `No access to bucket "${f.bucket}"`);
      if (!f.key.startsWith(grant.prefix)) {
        throw new AppError(403, 'FORBIDDEN', `Key "${f.key}" not under allowed prefix "${grant.prefix}"`);
      }
      const requiredPerm = f.method === 'GET' ? 'read' : 'write';
      if (!grant.permissions.includes(requiredPerm)) {
        throw new AppError(403, 'FORBIDDEN', `No "${requiredPerm}" permission`);
      }
    }

    const resource = await securityService.getByName(body.files[0]!.bucket);
    const urlTtl = resource?.presignedUrlTtl ?? 300;

    const urls = await Promise.all(
      body.files.map(async f => {
        const { provider } = await s3ProviderResolver(f.bucket);
        const url = f.method === 'GET'
          ? await provider.getPresignedUrl(f.bucket, f.key, urlTtl)
          : await provider.putPresignedUrl(f.bucket, f.key, urlTtl);
        return {
          bucket: f.bucket,
          key: f.key,
          url,
          expiresAt: new Date(Date.now() + urlTtl * 1000).toISOString(),
        };
      }),
    );

    return c.json(ok({ urls }));
  });

  // ── GET /api/security/list ──
  app.get('/list', async (c) => {
    const atomic = c.var.stores.atomic;
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      throw new AppError(401, 'UNAUTHORIZED', 'Missing or malformed Authorization header');
    }
    const { verifyToken, base64urlDecode } = await import('../../core/security/jwt.ts');
    const secretEntry = await atomic.get<string>('_sys:jwt-secret');
    if (!secretEntry?.value) throw new AppError(500, 'INTERNAL_ERROR', 'JWT secret not configured');
    const secret = base64urlDecode(secretEntry.value);
    const result = await verifyToken(authHeader.slice(7), secret);
    if (!result.valid) throw new AppError(401, 'UNAUTHORIZED', result.reason);

    const claims = result.claims;
    const query = ListQuerySchema.parse({
      bucket: c.req.query('bucket'),
      prefix: c.req.query('prefix'),
      limit: c.req.query('limit'),
      continuationToken: c.req.query('continuationToken'),
    });

    const grant = claims.grants.find(g => g.bucket === query.bucket);
    if (!grant) throw new AppError(403, 'FORBIDDEN', `No access to bucket "${query.bucket}"`);
    if (!grant.permissions.includes('list')) {
      throw new AppError(403, 'FORBIDDEN', `No "list" permission on "${query.bucket}"`);
    }

    const { provider } = await s3ProviderResolver(query.bucket);
    const s3Result = await provider.listObjects(query.bucket, {
      prefix: query.prefix,
      maxKeys: query.limit ?? 1000,
      ...(query.continuationToken ? { continuationToken: query.continuationToken } : {}),
    });

    return c.json(ok({
      files: (s3Result.contents ?? []).map(obj => ({
        key: obj.key,
        size: obj.size,
        lastModified: obj.lastModified,
      })),
      nextContinuationToken: s3Result.nextContinuationToken,
      isTruncated: s3Result.isTruncated ?? false,
    }));
  });

  return app;
}
```

**注意**: JWT 认证在三个容器端点中内联调用（而非使用 middleware.ts 的中间件函数），因为 OpenAPIHono 的中间件注册模式和普通 Hono 不同。Phase 3 的 `middleware.ts` 保留供未来普通 Hono router 使用。

### Step 5.4: 验证 Phase 5

```bash
npm run typecheck
```

**预期错误**:
- `applicator.ts` — 引用 `SecurityResourceRef`
- `sandbox.service.ts` — 引用旧类型
- `sandbox/types.ts` — `CreateSandboxInput.securityResources` 类型不匹配

这些在 Phase 6–7 修复。

---

## Phase 6 — 模板 + applicator

> **原则**: `securityRef` 替换为 `securityRefs`。applicator 只查策略存在性，不查 URL 有效性。

### Step 6.1: 更新 `src/features/template/types.ts`

**当前代码** (行 ~133):
```typescript
  /** 引用 SecurityResource 的名称。设置后容器内 /run/secrets/s3/{name}.json 出现此资源。 */
  readonly securityRef?: string | undefined;
```

**替换为**:
```typescript
  /** @deprecated 使用 securityRefs 替代 */
  readonly securityRef?: string | undefined;
  /** 引用 SecurityResource 的名称列表。可声明多个存储策略。 */
  readonly securityRefs?: readonly string[] | undefined;
```

### Step 6.2: 更新 `src/features/template/applicator.ts`

**import 变更** (行 2):
```typescript
// 删除 SecurityResourceRef, 添加 SandboxStorageAccess
import type { CreateSandboxInput, Volume, VolumeMount, SandboxNetworkConfig, SandboxStorageAccess } from '../sandbox/types.ts';
```

**`applyTemplate()` 参数** — `securityStore` 保留，类型不变:
```typescript
export async function applyTemplate(
  tpl: SandboxTemplate,
  name?: string,
  region?: string,
  resolveVolume?: (id: string) => Promise<Record<string, unknown> | null>,
  securityStore?: SecurityResourceService,
): Promise<CreateSandboxInput> {
```

**`mapStorage()` 签名** — `securityRefs` 返回值类型变更:
```typescript
export async function mapStorage(
  storage: readonly TemplateStorage[] | undefined,
  resolveVolume?: (id: string) => Promise<Record<string, unknown> | null>,
  securityStore?: SecurityResourceService,
): Promise<{
  volumes: Volume[];
  volumeMounts: VolumeMount[];
  configMapEnv: { name: string; value: string }[];
  securityRefNames: string[];
}> {
```

**storage 遍历逻辑** — 处理 `securityRefs` 和 `securityRef` (向后兼容):
```typescript
    // If securityRefs is set, collect names (mutually exclusive with other storage types)
    if ((s.securityRefs?.length || s.securityRef) && securityStore) {
      const names = s.securityRefs ?? (s.securityRef ? [s.securityRef] : []);
      for (const name of names) {
        const sec = await securityStore.getByName(name);
        if (!sec) {
          throw new Error(`SecurityResource "${name}" not found`);
        }
        // V3: only verify policy exists and is Active — JWT issued later at sandbox provision
        if (sec.status !== SecurityResourceStatus.Active) {
          throw new Error(`SecurityResource "${name}" is ${sec.status}`);
        }
        securityRefNames.push(name);
      }
      continue;
    }
```

需要在文件顶部 import `SecurityResourceStatus`:
```typescript
import { SecurityResourceStatus } from '../../core/security/types.ts';
```

**`applyTemplate()` 返回值** — `securityRefs` 改为 `securityRefNames` 传递:
```typescript
  return {
    // ... 所有现有字段
    ...(securityRefNames.length > 0 ? { securityRefNames } : {}),
  };
```

### Step 6.3: 更新 `CreateSandboxInput` 对应字段

**文件**: `src/features/sandbox/types.ts`

删除旧的 `securityResources`:
```typescript
  // 删除这行:
  readonly securityResources?: readonly SecurityResourceRef[] | undefined;
```

新增 `securityRefNames`:
```typescript
  /** SecurityResource names to resolve for S3 access. The JWT token is issued at provision time. */
  readonly securityRefNames?: readonly string[] | undefined;
```

### Step 6.4: 验证 Phase 6

```bash
npm run typecheck
```

---

## Phase 7 — Sandbox 注入层

> **原则**: `toPodSpec()` 用 SecurityResourceService 签发 JWT，注入 `/run/secrets/s3/token` 单一文件。

### Step 7.1: 更新 `src/features/sandbox/sandbox.service.ts`

**添加 import**:
```typescript
import { SecurityResourceService } from '../../core/security/service.ts';
```

**修改 `toPodSpec()` 函数签名** — 接受 `securityStore` 和 `sandboxId`:
```typescript
async function toPodSpec(
  input: CreateSandboxInput,
  securityStore?: SecurityResourceService,
): Promise<PodSpec> {
```

**替换 securityMounts 生成逻辑** (行 646–650):
```typescript
  let securityMounts: SecretMountConfig[] = [];

  if (input.securityRefNames?.length && securityStore) {
    const { token, expiresAt } = await securityStore.issueToken(
      input.securityRefNames,
      // sandboxId — use the name as a fallback identifier since we don't have the ID yet
      input.name,
    );
    securityMounts = [{
      mountPath: '/run/secrets/s3/token',
      data: token,
      mode: 0o600,
    }];
  }
```

**修改 `provision()` 调用 `toPodSpec` 的地方** (行 170):
```typescript
    const securityStore = new SecurityResourceService(this.atomic, this.logger);
    const podSpec = await toPodSpec(input, securityStore);
```

### Step 7.2: 验证 Phase 7

```bash
npm run typecheck
```

**预期**: 零错误。所有 V2 遗留引用已清除，新类型链路完整闭合。

---

## Phase 8 — 清理与验证

### Step 8.1: 删除 `autoGenerateKeys` 残留

**文件**: `src/features/topology/response-schema.ts`

检查 `RegionBucketSchema` 中是否有 `autoGenerateKeys: z.boolean().optional()`。如果存在，删除该行。

注：若 Phase 1 前已删除（当前基线可能已被用户手动清理），则跳过。

### Step 8.2: 删除 `security-refresh.ts` 文件

```bash
rm src/core/events/security-refresh.ts
```

（如果 Phase 1 已执行则跳过）

### Step 8.3: 删除 `app.ts` 中未使用的 import

从 `src/core/app.ts` 中删除：
```typescript
import { registerSecurityRefresh } from './events/security-refresh.ts';  // 行 43
```

确认 `SecurityResourceService` 不再被 `app.ts` 直接引用（现在只在 `sandbox.service.ts` 中使用）。如果有残留 import，删除。

### Step 8.4: 验证闭环

```bash
npm run typecheck   # 必须通过，零错误
npm run lint        # 必须通过
npm test            # 必须通过（需要更新测试——见 Phase 9）
npm run map         # 确认无新死代码
```

### Step 8.5: 全局 Grep 验证

```bash
# 确认无 V2 残留
grep -rn "PresignedUrlSet" src/        # 应无匹配
grep -rn "SecurityResourceRef" src/    # 应无匹配
grep -rn "security-refresh" src/       # 应无匹配
grep -rn "checkValidity" src/          # 应无匹配
grep -rn "autoGenerateKeys" src/       # 应无匹配
grep -rn "bucket-key" src/             # 应无匹配
grep -rn "BucketKeyBinding" src/       # 应无匹配

# 确认 V3 通路存在
grep -rn "sandbox.service.ts" -e "issueToken"   # 应有 1 个调用
grep -rn "sandbox.service.ts" -e "JWT"          # 应有引用
grep -rn "jwt.ts" -e "signToken"                # 应有导出
```

---

## Phase 9 — 测试更新

### 需要更新的测试文件

| 测试 | 变更原因 |
|---|---|
| `security/service` 的测试 | `provision()` 签名变了（不再接受 s3Provider 参数）；新增 `issueToken()` |
| `security/handler` 的测试 | CRUD 端点字段变了；新增 3 个容器端点 |
| `applicator` 的测试 | `securityRef` → `securityRefs`；不再期望 `SecurityResourceRef` 输出 |
| `sandbox.service` 的测试 | `toPodSpec()` 注入 token 而非 URL JSON |
| `security-refresh` 的测试 | 文件删除，测试删除 |
| `template/types` 的测试 | `securityRefs` 字段新增 |

### 新增测试

| 测试 | 内容 |
|---|---|
| `core/security/jwt.test.ts` | `signToken` + `verifyToken` 往返；过期 token 拒绝；篡改 token 拒绝；Secret 自举 |
| `core/security/service.test.ts:issueToken` | 多 resource 策略合并；token claims 验证；不存在的 resource 抛错 |
| `features/security/handler.test.ts:presign` | JWT auth 成功/失败；prefix 鉴权；permission 鉴权（read vs write） |

---

## 依赖关系图

```
Phase 1 (删除) ─────────────────────────────────────────────────────┐
  │                                                                  │
Phase 2 (types.ts 重写) ──┐                                          │
  │                       │                                          │
Phase 3 (jwt.ts) ─────────┤                                          │
  │                       ├── Phase 4 (service.ts 重写) ──┐           │
  │                       │                                │           │
  │                       │    Phase 3 (middleware.ts) ────┤           │
  │                       │                                │           │
  │                       │                                ├── Phase 5 │
  │                       │                                │   (API)  │
  │                       │                                │          │
  │                       ├── Phase 6 (applicator) ────────┤           │
  │                       │                                │          │
  │                       └── Phase 7 (sandbox) ───────────┘          │
  │                                                                    │
  └──────────────────────────────── Phase 8 (cleanup + grep) ──────────┘
```

- Phase 1–7 **依序执行**，每步完成后 `npm run typecheck` 确认错误模式符合预期
- Phase 2 是所有后续阶段的类型基础
- Phase 3 (jwt.ts) 和 Phase 4 (service.ts) 可并行
- Phase 5 必须在 Phase 3 + 4 完成后执行
- Phase 6 + 7 必须在 Phase 2 + 4 完成后执行

---

## 回滚策略

每个 Phase 对应一个独立的 git commit。如果某 Phase 引入的编译错误数量远超预期，`git reset --hard HEAD~1` 回到上一个干净状态，检查原因后重做。

**绝对禁止**：
- 跳过 Phase 直接做后面的
- 在一个 commit 中混合多个 Phase 的变更
- 使用 `as any` 或 `eslint-disable` 压制编译错误来让 CI 通过

---

## 陷阱与注意事项

### P1: JWT Secret 的编码/解码必须一致

JWT secret 是 32 字节的随机二进制数据。在 KV 中存储为 **base64url** 字符串。所有读写都必须使用 `jwt.ts` 导出的 `base64url()` / `base64urlDecode()`。

**错误示范**（本日志初版引入的 bug）:
```typescript
// 存储: hex 字符串
const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
await atomic.set(JWT_SECRET_KEY, hex, null);

// 加载: 逐字符取 charCode
const secret = new Uint8Array(hexEntry.value.split('').map(ch => ch.charCodeAt(0)));
// BUG: hex 字符串 "a1" → [97, 49]，而非字节 0xa1
// 签名和验证用的 key 不同 → 永远验证失败
```

**正确做法**: 统一用 base64url。
```typescript
// 存储
await atomic.set(JWT_SECRET_KEY, base64url(bytes.buffer), null);
// 加载
return base64urlDecode(entry.value);
```

**验证方法**: 写一个单元测试 —— `signToken(claims, secret)` 然后用同样的 secret `verifyToken(token, secret)`，确认往返成功。如果失败，检查 secret 的编解码路径。

### P2: Web Crypto 输入必须是 Uint8Array

`crypto.subtle.sign('HMAC', key, data)` 的 `data` 必须是 `Uint8Array`（或 `BufferSource`），不能是 `string`。在 jwt.ts 中所有传给 `crypto.subtle` 的数据都通过 `ENCODER.encode()` 转换。

### P3: `issueToken` 中 grants 的结构

`SecurityResource.accessPolicy` 是 `StorageAccessEntry[]`（多个前缀，每个有独立权限）。但 JWT claims 中的 `grants` 也是数组（与 `accessPolicy` 一致），每个 grant 有独立的 `bucket + prefix + permissions`。

**当前的简化**: `issueToken` 只取了每个 resource 的第一个 `accessPolicy[0]`。如果单个 resource 需要多个不同前缀的权限（如 "game-data/" 只读 + "user-uploads/" 可写），需要展开 `accessPolicy` 的每个 entry 到 `grants` 中。

**TODO**: 修正 `issueToken` 为：
```typescript
grants: found.flatMap(r =>
  r.accessPolicy.map(entry => ({
    bucket: r.bucketId,
    prefix: entry.prefix,
    permissions: entry.permissions,
  }))
),
```

### P4: ES256 在当前实现中不可用

本实现使用 **HS256**（对称密钥，HMAC-SHA256）。签发和验证用同一个 secret。不涉及公私钥对。如需 RS256/ES256（非对称），需要额外引入 `crypto.subtle.generateKey`——那是另一个任务。

### P5: 日志中不要记录 JWT token

`issueToken` 返回的 token 是敏感凭证。禁止在任何 audit log、console.log、error message 中打印完整 token。如需追踪，用 `claims.jti`（UUID）即可。
