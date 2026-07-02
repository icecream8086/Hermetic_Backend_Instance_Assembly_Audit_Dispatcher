# S3 Security 资源 + 预签名 URL — 实现规范 v2

> **Status**: Implemented (2026-07-03)
> **日期**: 2026-07-03
> **目标读者**: 维护者

---

## 实现状态

| 模块 | 文件 | 状态 |
|---|---|---|
| 类型定义 | `src/core/security/types.ts` | ✅ |
| 核心服务 | `src/core/security/service.ts` | ✅ |
| 自动刷新 | `src/core/events/security-refresh.ts` | ✅ |
| API 端点 | `src/features/security/` (handler + schema + index) | ✅ |
| 删除旧代码 | BucketKeyBinding / autoGenerateKeys / bucketMounts / OSS case / queue bucket-key-rotate | ✅ |
| 模板装配 | `applicator.ts` — securityRef 解析 + 有效期检查 | ✅ |
| 注入通道 | `sandbox.service.ts` → `toPodSpec()` → `podSpecToGroupInput()` → `secretMounts` | ✅ |
| ECI 编码 | `eci-codec.ts` — `ConfigFileVolume` 编码 | ✅ |
| Podman | 已有 `secretMounts` 处理（libpod secrets → tmpfs），无需改动 | ✅ |
| Provider 注册 | `app.ts` — `registerSecurityRefresh()` 已注册 | ✅ |
| 按需 GET 签名 API | `GET /api/security/{id}/presign?key=` | 后续 |
| 平台原生凭证 | ECI RAM 角色 / `value.type = 'ramRole'` | 后续 |
| 多后端 s3Resolver | `app.ts` 当前使用全局 `providers.s3Account()` | 后续 |

### 已知注意事项

1. **ECI `ConfigFileVolume` 参数名需确认** — `eci-codec.ts` 使用 `ConfigFileVolume.N.MountPath` / `.Payload` / `.FilePermission`。如果 ECI API 实际参数名不同，需调整。
2. **`app.ts` s3Resolver 使用全局 provider** — 所有 SecurityResource 共用同一个 S3 provider。多后端场景需改为按 `bucketId` 查找 `RegionBucket` → `credentialRef` → 解析对应 provider。
3. **ESLint 规则 `enforce-decode-layer` 的 AST bug** — `await c.req.json()` 使规则误报，因为父节点是 `AwaitExpression` 而非 `.parse()` 的 `CallExpression`。已在 `handler.ts` 加 `eslint-disable-next-line` 绕过。

### 废弃文档

以下 SPEC 已被本方案取代，不再维护：

- `SPEC/s3-auto-key-provision.md` — AK/SK 密钥对方案（被 presigned URL 取代）
- `SPEC/s3-policy-manager.md` — MinIO IAM 策略方案（被 SecurityResource + presigned URL 取代）

---

## 0. 方案决策

### 0.1 为什么是预签名 URL，不是 STS

| 方案 | 问题 |
|---|---|
| STS / AssumeRoleWithWebIdentity | 需要容器内有 JWT（K8s SA token），ECI 和 Podman 都没有。Worker 环境兼容性未知。 |
| 后端代理 | 单点故障 + 性能瓶颈，所有 S3 流量经过 Worker。 |
| POST Policy | 仅写入，不适用读取场景。 |
| **预签名 URL** ✅ | Worker 用 admin 凭证代签，容器直接用 URL。无 SDK 依赖，无平台限制。 |

### 0.2 预签名 URL 的已知局限

预签名 URL 绑定单个 object key。一个 URL 只能操作一个对象。

| URL | 用途 | 签名的 key |
|---|---|---|
| `getUrl` | GET 单个对象 | `{prefix}/placeholder`（占位） |
| `putUrl` | PUT 单个对象 | `{prefix}/placeholder`（占位） |
| `listUrl` | 列举 bucket 内对象 | 无（bucket-level 操作） |

### 0.3 多对象读取 — 后续方案

本次不实现，写入 SPEC 留档：

```
容器内流程：
  1. cat /run/secrets/s3/{name}.json → 拿到 listUrl
  2. curl $listUrl → 获取对象列表（XML/JSON）
  3. 对需要读取的特定 key，调 Worker API：
       GET /api/security/{id}/presign?key={objectKey}&method=GET
     Worker 返回单个 presigned GET URL
  4. curl $presignedGetUrl → 下载对象
```

本次仅注入 `listUrl` + 一组占位 `getUrl`/`putUrl`。按需签名的 API 端点后续再加。

### 0.4 ECI 平台原生 — 后续方案

未来如果 ECI 支持直接通过 RAM 角色访问 OSS，`SecurityResource.value` 可扩展为：

```typescript
type SecurityResourceValue =
  | { type: 'presigned'; urls: PresignedUrlSet }
  | { type: 'ramRole'; roleName: string; ... };
```

容器根据 `type` 决定走文件注入还是 metadata service。第一期只做 `presigned`。

---

## 架构概述

用**预签名 URL（Presigned URL）**替代 AK/SK 密钥对，作为 S3 访问凭证注入容器。

```
RegionBucket（存储实例，绑定 ComputeInstance）
  │
  └─ SecurityResource（自动管理，1 bucket : 1 resource）
       │  id, name, bucketId, instanceId
       │  validDuration: 预签名有效时长（秒），默认 3600（1h）
       │  refreshThreshold: 剩余有效期低于此值触发刷新（秒），默认 900（15min）
       │  status: Active | Expired | Revoked
       │  value: PresignedUrlSet（自动刷新，值可变）
       │
       ├─ applicator.ts — resolve 阶段检查有效期
       │    剩余 < refreshThreshold → 自动刷新
       │    已过期 → 拒绝创建 Sandbox
       │
       ├─ sandbox.service.ts — toPodSpec() 将 value 序列化为 JSON 注入 secretMounts
       │
       ├─ event-loop tick — 扫描即将过期的资源，自动续期
       │
       └─ 容器内 → /run/secrets/s3/{name}.json
```

### 新旧对比

| | 旧方案（autoGenerateKeys） | 新方案（SecurityResource） |
|---|---|---|
| 凭证类型 | AK/SK 密钥对 | 预签名 URL 组（GET+PUT+LIST） |
| 容器使用方式 | SDK 用 AK/SK 签名请求 | 直接用 URL（curl / HTTP 客户端） |
| 有效期管理 | 24h 轮转 AK/SK | 系统自动刷新 URL |
| ECI 注入 | 卡住（不支持内联 Secret） | URL 是普通字符串，文件挂载即可 |
| 泄露风险 | AK/SK 可长期滥用 | URL 天然有时效，窗口可控 |
| 存储 | `BucketKeyBinding`（AK:SK 明文） | `SecurityResource.value`（URL 组 JSON） |
| SDK 兼容 | 全兼容 | 不需要 SDK |

---

## 1. 删除清单

以下代码/字段将在本次全部删除，不留 deprecated 标记（从未使用过）：

| 文件 | 删除内容 | 行号（参考） |
|---|---|---|
| `src/core/region/bucket.ts` | `BucketKeyBinding` 接口 | 49-58 |
| `src/core/region/bucket.ts` | `generateS3KeyPair()` 函数 | 61-67 |
| `src/core/region/bucket.ts` | `RegionBucket.autoGenerateKeys` 字段 | ~22 |
| `src/core/region/bucket.ts` | `CreateBucketInput.autoGenerateKeys` | ~ |
| `src/core/region/bucket.ts` | `UpdateBucketInput.autoGenerateKeys` | ~ |
| `src/features/topology/types.ts` | `CreateBucketBody.autoGenerateKeys` | ~ |
| `src/features/topology/types.ts` | `UpdateBucketBody.autoGenerateKeys` | ~ |
| `src/features/sandbox/types.ts` | `CreateSandboxInput.bucketMounts` 字段 | 395-402 |
| `src/features/sandbox/sandbox.service.ts` | `provision()` 中密钥生成 + binding 存储逻辑 | 165-189 |
| `src/features/sandbox/sandbox.service.ts` | `terminate()` 中 binding 清理逻辑 | 316-326 |
| `src/features/template/applicator.ts` | `mapStorage()` 中 bucketId 解析块（resolveBucket 参数） | 244-258 |
| `src/features/template/applicator.ts` | `mapStorage()` 中 `case 'oss'` 分支（NFS 占位 bug） | 293-302 |
| `src/features/template/applicator.ts` | `bucketMounts` 相关变量和返回值 | ~ |
| `src/core/events/health-check.ts` | bucket-key 过期扫描 | 288-317 |
| `src/queue/consumer.ts` | `handleBucketKeyRotate()` | 312-342 |

### `mapStorage()` 返回值变更

删除 `bucketMounts` 后：

```typescript
export async function mapStorage(
  storage: readonly TemplateStorage[] | undefined,
  resolveVolume?: (id: string) => Promise<Record<string, unknown> | null>,
  // 删除 resolveBucket 参数
): Promise<{
  volumes: Volume[];
  volumeMounts: VolumeMount[];
  configMapEnv: { name: string; value: string }[];
  // 删除 bucketMounts
}>
```

`applyTemplate()` 中调用 `mapStorage()` 的地方同步调整，删除 `bucketMounts` 的解构和传递。

### `TemplateStorage` 类型清理

`TemplateStorage.oss`、`TemplateStorage.bucketId` 字段不再出现在数据流中（保留接口声明但标 `@deprecated`，向后兼容旧模板 YAML）。

---

## 2. 新增类型定义

### 2.1 文件：`src/core/security/types.ts`（新建）

```typescript
import type { BrandedId } from '../brand.ts';
import type { InstanceId } from '../region/instance.ts';

// ─── Brand types ───

export type SecurityResourceId = BrandedId<'SecurityResourceId'>;

// ─── Presigned URL set ───

/**
 * 一组预签名 URL。由 SecurityResourceService 自动刷新。
 *
 * 多对象读取（后续）：容器用 listUrl 列举 → 调 Worker API
 *   GET /api/security/{id}/presign?key={objectKey}&method=GET
 * 按需获取单对象 presigned GET URL。
 */
export interface PresignedUrlSet {
  /** 预签名 PUT URL（写入对象）。 */
  readonly putUrl: string;
  /** 列举 bucket 内对象的 URL。bucket-level，不需要绑定具体 key。 */
  readonly listUrl: string;
  /** S3 endpoint。 */
  readonly endpoint: string;
  /** Bucket 名称。 */
  readonly bucket: string;
  /** Bucket 所在 region。 */
  readonly region: string;
  /** URL 过期时间（ISO 8601）。 */
  readonly expiresAt: string;
}

// ─── Status ───

export enum SecurityResourceStatus {
  Active = 'Active',
  Expired = 'Expired',
  Revoked = 'Revoked',
}

// ─── Entity ───

export interface SecurityResource {
  readonly id: SecurityResourceId;
  readonly name: string;
  /** 关联的 S3 存储桶 ID（RegionBucket.id）。 */
  readonly bucketId: string;
  /** 计算实例 ID，用于确定 platform + 解析 S3 provider。 */
  readonly instanceId: InstanceId;
  /** 预签名 URL 有效时长（秒）。默认 3600（1h）。 */
  readonly validDuration: number;
  /** 剩余有效期低于此阈值时触发自动刷新（秒）。默认 900（15min）。 */
  readonly refreshThreshold: number;
  /** 当前状态。 */
  readonly status: SecurityResourceStatus;
  /** 当前的预签名 URL 组。刷新时整体替换。 */
  readonly value: PresignedUrlSet;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ─── CRUD inputs ───

export interface CreateSecurityResourceInput {
  readonly name: string;
  readonly bucketId: string;
  readonly instanceId: InstanceId;
  readonly validDuration?: number | undefined;      // 默认 3600
  readonly refreshThreshold?: number | undefined;   // 默认 900
}

export interface UpdateSecurityResourceInput {
  readonly name?: string | undefined;
  readonly validDuration?: number | undefined;
  readonly refreshThreshold?: number | undefined;
  readonly status?: SecurityResourceStatus | undefined;
}
```

### 2.2 文件：`src/features/sandbox/types.ts` — 新增字段

在 `CreateSandboxInput` 接口中添加：

```typescript
  /** 引用的 SecurityResource 列表。applicator 解析后填充，注入容器时使用。 */
  readonly securityResources?: readonly SecurityResourceRef[] | undefined;
```

新增类型：

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

### 2.3 文件：`src/features/template/types.ts` — 新增字段

在 `TemplateStorage` 接口中添加：

```typescript
  /** 引用 SecurityResource 的名称。设置后容器内 /run/secrets/s3/{name}.json 出现此资源。 */
  readonly securityRef?: string | undefined;
```

---

## 3. SecurityResourceService

### 文件：`src/core/security/service.ts`（新建）

```typescript
import type { IAtomicStore } from '../store/interfaces.ts';
import type { IAuditWriter } from '../audit/types.ts';
import type { SecurityResource, SecurityResourceId, CreateSecurityResourceInput,
  UpdateSecurityResourceInput, PresignedUrlSet } from './types.ts';
import { SecurityResourceStatus } from './types.ts';
import type { IS3Provider } from '../provider/s3.ts';

const PREFIX = 'security:';
const INDEX_KEY = 'security:ids';

export class SecurityResourceService {
  constructor(
    private readonly atomic: IAtomicStore,
    private readonly logger: IAuditWriter,
  ) {}

  // ── Provision ──

  /**
   * 创建 SecurityResource，首次签发 presigned URL 组。
   * @param s3Provider — 已用 admin 凭证初始化的 IS3Provider 实例
   */
  async provision(
    input: CreateSecurityResourceInput,
    s3Provider: IS3Provider,
    bucketName: string,
    endpoint: string,
    region: string,
  ): Promise<SecurityResource> {
    const now = Date.now();
    const expiresIn = input.validDuration ?? 3600;

    // 签发 presigned URLs
    // putUrl: 为前缀 + 占位 key 签发 PUT
    const putUrl = await s3Provider.putPresignedUrl(bucketName, '_placeholder_', expiresIn);
    // listUrl: bucket-level GET（用于列举对象）
    const listUrl = await s3Provider.getPresignedUrl(bucketName, '', expiresIn);

    const value: PresignedUrlSet = {
      putUrl,
      listUrl,
      endpoint,
      bucket: bucketName,
      region,
      expiresAt: new Date(now + expiresIn * 1000).toISOString(),
    };

    const id = crypto.randomUUID() as SecurityResourceId;
    const resource: SecurityResource = {
      id, name: input.name,
      bucketId: input.bucketId,
      instanceId: input.instanceId,
      validDuration: input.validDuration ?? 3600,
      refreshThreshold: input.refreshThreshold ?? 900,
      status: SecurityResourceStatus.Active,
      value, createdAt: now, updatedAt: now,
    };

    await this.atomic.set(`${PREFIX}${id}`, resource, null);
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    await this.atomic.set(INDEX_KEY, [...(idx?.value ?? []), id], idx?.version ?? null);
    return resource;
  }

  // ── Read ──

  async getById(id: SecurityResourceId): Promise<SecurityResource | null> {
    const entry = await this.atomic.get<SecurityResource>(`${PREFIX}${id}`);
    return entry?.value ?? null;
  }

  async getByName(name: string): Promise<SecurityResource | null> {
    const all = await this.list();
    return all.find(r => r.name === name) ?? null;
  }

  async list(status?: SecurityResourceStatus): Promise<SecurityResource[]> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    if (!idx?.value?.length) return [];
    const entries = await Promise.all(
      idx.value.map(id => this.atomic.get<SecurityResource>(`${PREFIX}${id}`)),
    );
    const resources = entries
      .filter((e): e is NonNullable<typeof e> => e !== null && e.value !== null)
      .map(e => e.value);
    return status ? resources.filter(r => r.status === status) : resources;
  }

  // ── Refresh — 重新签发 presigned URL ──

  async refresh(id: SecurityResourceId, s3Provider: IS3Provider): Promise<SecurityResource> {
    const entry = await this.atomic.get<SecurityResource>(`${PREFIX}${id}`);
    if (!entry?.value) throw new Error(`SecurityResource ${id} not found`);
    const resource = entry.value;
    if (resource.status === SecurityResourceStatus.Revoked) {
      throw new Error(`Cannot refresh revoked SecurityResource ${id}`);
    }

    const expiresIn = resource.validDuration;
    const now = Date.now();
    const [putUrl, listUrl] = await Promise.all([
      s3Provider.putPresignedUrl(resource.value.bucket, '_placeholder_', expiresIn),
      s3Provider.getPresignedUrl(resource.value.bucket, '', expiresIn),
    ]);

    const updated: SecurityResource = {
      ...resource,
      value: {
        ...resource.value,
        putUrl,
        listUrl,
        expiresAt: new Date(now + expiresIn * 1000).toISOString(),
      },
      status: SecurityResourceStatus.Active,
      updatedAt: now,
    };

    await this.atomic.set(`${PREFIX}${id}`, updated, entry.version);
    return updated;
  }

  // ── Check validity — applicator 调用 ──

  /**
   * 检查资源是否仍然有效。
   * - 状态非 Active → 无效
   * - 已过期 → 无效
   * - 剩余有效期 < refreshThreshold → 无效（需要刷新）
   */
  checkValidity(resource: SecurityResource): { valid: boolean; reason?: string } {
    const now = Date.now();
    const expiresAt = new Date(resource.value.expiresAt).getTime();
    const remaining = expiresAt - now;

    if (resource.status !== SecurityResourceStatus.Active) {
      return { valid: false, reason: `SecurityResource "${resource.name}" is ${resource.status}` };
    }
    if (remaining <= 0) {
      return { valid: false, reason: `SecurityResource "${resource.name}" has expired` };
    }
    if (remaining < resource.refreshThreshold * 1000) {
      return {
        valid: false,
        reason: `SecurityResource "${resource.name}" expires in ${Math.round(remaining / 1000)}s (threshold: ${resource.refreshThreshold}s). Trigger refresh first.`,
      };
    }
    return { valid: true };
  }

  // ── Revoke / Delete ──

  async markExpired(id: SecurityResourceId): Promise<void> {
    const entry = await this.atomic.get<SecurityResource>(`${PREFIX}${id}`);
    if (entry?.value) {
      await this.atomic.set(`${PREFIX}${id}`, { ...entry.value, status: SecurityResourceStatus.Expired, updatedAt: Date.now() }, entry.version);
    }
  }

  async revoke(id: SecurityResourceId): Promise<void> {
    const entry = await this.atomic.get<SecurityResource>(`${PREFIX}${id}`);
    if (entry?.value) {
      await this.atomic.set(`${PREFIX}${id}`, { ...entry.value, status: SecurityResourceStatus.Revoked, updatedAt: Date.now() }, entry.version);
    }
  }

  async delete(id: SecurityResourceId): Promise<void> {
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

### IS3Provider — 去掉可选标记

`src/core/provider/s3.ts` 中 `getPresignedUrl` 和 `putPresignedUrl` 去掉 `?`，改为必需方法：

```typescript
export interface IS3Provider {
  // ... 现有其他方法不变
  getPresignedUrl(bucket: string, key: string, expiresInSeconds?: number): Promise<string>;
  putPresignedUrl(bucket: string, key: string, expiresInSeconds?: number): Promise<string>;
}
```

三个已有实现（`AwsS3Provider`、`CloudflareR2S3Provider`、`AlibabaOssProvider`）中这两个方法已经存在，无需改动方法体。

---

## 4. applicator.ts — 模板装配层

### 文件：`src/features/template/applicator.ts`

#### 4a. `applyTemplate()` 参数变更

新增参数：

```typescript
export async function applyTemplate(
  tpl: SandboxTemplate,
  name?: string,
  region?: string,
  resolveVolume?: (id: string) => Promise<Record<string, unknown> | null>,
  securityStore?: SecurityResourceService,  // ← 新增
): Promise<CreateSandboxInput>
```

#### 4b. `mapStorage()` — 新增 securityRef 解析

在函数签名中新增参数，在处理 `TemplateStorage` 时，如果 `s.securityRef` 有值：

```typescript
const securityRefs: SecurityResourceRef[] = [];

for (const s of storage) {
  // 如果声明了 securityRef，查询 SecurityResource
  if (s.securityRef && securityStore) {
    const sec = await securityStore.getByName(s.securityRef);
    if (!sec) {
      throw new Error(`SecurityResource "${s.securityRef}" not found`);
    }
    const check = securityStore.checkValidity(sec);
    if (!check.valid) {
      throw new Error(check.reason!);
    }
    // 收集引用（不创建 Volume，不走卷挂载路径）
    securityRefs.push({
      resourceId: sec.id,
      resourceName: sec.name,
      value: sec.value,
    });
    // 跳过 Volume 创建
    continue;
  }
  // ... 其余 storage 逻辑不变
}
```

**注意**：`securityRef` 和 `volumeId`/`bucketId`/`oss`/`nfs` 互斥。如果同时声明，`securityRef` 优先。

#### 4c. `applyTemplate()` 返回值

将收集到的 `securityRefs` 写入：

```typescript
return {
  // ... 现有字段
  ...(securityRefs.length > 0 ? { securityResources: securityRefs } : {}),
};
```

#### 4d. 删除 OSS case + bucketId 解析

`mapStorage()` 中删除：
- `resolveBucket` 参数
- `bucketId` 解析块（约 244-258 行）
- switch 中的 `case 'oss'`（约 293-302 行）
- `bucketMounts` 变量和返回值字段

---

## 5. sandbox.service.ts — 注入层

### 文件：`src/features/sandbox/sandbox.service.ts`

#### 5a. 删除旧 key generation

删除 `provision()` 中第 165-189 行（`const BINDING_PREFIX = 'bucket-key:'` 起至 `}` 结束）。

删除 `terminate()` 中第 316-326 行（binding 清理逻辑）。

#### 5b. `toPodSpec()` — 将 SecurityResource 注入为 secretMounts

```typescript
// 在 toPodSpec() 中：
const securityMounts: SecretMountConfig[] = input.securityResources?.map(sr => ({
  mountPath: `/run/secrets/s3/${sr.resourceName}.json`,
  data: JSON.stringify(sr.value),
  mode: 0o600,
})) ?? [];
```

#### 5c. PodSpec 透传路径

**`src/core/pod/types.ts`** — `PodSpec.spec` 中新增：

```typescript
readonly secretMounts?: readonly SecretMountConfig[] | undefined;
```

**`src/core/pod/service.ts`** — `podSpecToGroupInput()` 中透传：

```typescript
secretMounts: spec.spec.secretMounts,
```

最终落在 `CreateContainerGroupInput.secretMounts`（该字段已存在于 `src/core/provider/types.ts:361`）。

---

## 6. ECI codec 层 — SecretMounts 编码

### 文件：`src/providers/alibaba/eci-codec.ts`

#### 6a. `buildCreateParams()` — 处理 secretMounts

在 `buildCreateParams()` 中，volume 编码之后新增：

```typescript
// ── Secret Mounts ──
if (input.secretMounts?.length) {
  // ECI 不支持内联 Secret 数据，但 URLs 非密钥，走 ConfigFile Volume
  input.secretMounts.forEach((sm, i) => {
    const spfx = `ConfigFileVolume.${String(i + 1)}`;
    p[`${spfx}.MountPath`] = sm.mountPath;
    p[`${spfx}.Payload`] = sm.data;
    p[`${spfx}.FilePermission`] = String(sm.mode ?? 0o600);
  });
}
```

同样在 `buildPodCreateParams()` 中添加相同的编码逻辑。

> **实现前确认**: ECI `CreateContainerGroup` API 中 `ConfigFileVolume` 参数的确切路径名（`ConfigFileVolume` vs `ConfigFile`）。如不支持 ConfigFile，退而求其次：
> - 第一个容器的 `Container.1.EnvironmentVar` 中注入 `S3_CREDENTIALS_JSON=...`
> - 或拆分为 `S3_PUT_URL`、`S3_LIST_URL`、`S3_ENDPOINT`、`S3_BUCKET`、`S3_REGION`、`S3_EXPIRES_AT` 六个环境变量

> **Podman 路径**: `podman-provider.ts:196-223` 已有完整的 secretMounts 处理（libpod secrets → tmpfs），无需改动。

---

## 7. event-loop 自动刷新

### 文件：`src/core/event-bus/loop.ts` 或 `src/app.ts`

新增 tick 回调（每 5 分钟执行）：

```typescript
const REFRESH_TICK_MS = 5 * 60 * 1000;

async function refreshExpiringSecurityResources(
  securityService: SecurityResourceService,
  s3Resolver: (bucketId: string) => Promise<IS3Provider>,
): Promise<void> {
  const resources = await securityService.list(SecurityResourceStatus.Active);
  for (const r of resources) {
    const check = securityService.checkValidity(r);
    if (check.valid) continue;

    if (check.reason?.includes('expires in')) {
      // 剩余不足 refreshThreshold → 刷新
      try {
        const s3 = await s3Resolver(r.bucketId);
        await securityService.refresh(r.id, s3);
      } catch (e) {
        console.error(`[security] refresh failed for ${r.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (check.reason?.includes('expired')) {
      // 已过期 → 标记
      await securityService.markExpired(r.id);
    }
  }
}
```

---

## 8. API 端点

### 文件：`src/features/security/` 新建 feature

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/security` | 创建 SecurityResource，自动签发 presigned URL 组 |
| `GET` | `/api/security` | 列出所有（value 脱敏，仅显示 expiresAt） |
| `GET` | `/api/security/{id}` | 获取单个（value 脱敏，仅显示 expiresAt） |
| `POST` | `/api/security/{id}/refresh` | 手动刷新 presigned URLs |
| `POST` | `/api/security/{id}/revoke` | 吊销（标记 Revoked，不再自动刷新） |
| `DELETE` | `/api/security/{id}` | 删除资源 |

Feature 注册到 `src/features/generated.ts`。

---

## 9. 容器内契约

### 文件路径

```
/run/secrets/s3/{resourceName}.json
```

示例：`/run/secrets/s3/game-saves.json`

### 文件内容

```json
{
  "putUrl": "https://bucket.s3.cn-hangzhou.aliyuncs.com/_placeholder_?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=...&X-Amz-Expires=3600&X-Amz-Signature=...",
  "listUrl": "https://bucket.s3.cn-hangzhou.aliyuncs.com/?list-type=2&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=...&X-Amz-Expires=3600&X-Amz-Signature=...",
  "endpoint": "https://s3.cn-hangzhou.aliyuncs.com",
  "bucket": "game-saves",
  "region": "cn-hangzhou",
  "expiresAt": "2026-07-03T12:00:00Z"
}
```

### 容器内使用

```bash
#!/bin/sh
S3_JSON="/run/secrets/s3/game-saves.json"

# 列举 bucket 内容
LIST_URL=$(jq -r '.listUrl' "$S3_JSON")
curl -s "$LIST_URL"

# 写入对象：替换 placeholder 为实际 key
PUT_URL=$(jq -r '.putUrl' "$S3_JSON")
ACTUAL_URL=$(echo "$PUT_URL" | sed 's/_placeholder_/my-file.txt/')
curl -s -X PUT -T /tmp/my-file.txt "$ACTUAL_URL"
```

> **注意**: `putUrl` 签名的 key 是 `_placeholder_`。容器使用时需要将 URL 中的 `_placeholder_` 替换为实际写入的 object key。由于 S3 presigned URL 签名绑定 key，替换 key 后 URL 会失效。**因此当前的 `putUrl` 仅对 `_placeholder_` 这个 key 有效。** 后续通过 Worker API 按需签名支持任意 key。

---

## 10. 不在此次范围的后续工作

| 任务 | 说明 |
|---|---|
| 按需 GET 签名 API | `GET /api/security/{id}/presign?key={k}&method=GET` — 容器按需获取单对象 presigned URL |
| 按需 PUT 签名 API | `GET /api/security/{id}/presign?key={k}&method=PUT` — 容器按需获取单对象写入 URL |
| ECI RAM 角色 | `SecurityResource.value.type = 'ramRole'` — 不注入 URL，容器走 metadata service |
| 平台原生凭证 | Provider 维度接口 `ITemporaryCredentialProvider`，平台直接签 AK/SK 而非 URL |
| ECI ConfigFileVolume | 确认 ECI API 是否支持内联文件卷，调整注入方式 |

---

## 11. 验证

```bash
npm run typecheck   # 必须通过
npm run lint        # 必须通过
npm test            # 必须通过
npm run map         # 确认无新增死代码
```

### 最小验证流程

1. 创建 Bucket（绑定 ComputeInstance）
2. `POST /api/security` 创建 SecurityResource → Worker 签发 presigned URL 组
3. 创建 Template，`extensions.storage` 中 `securityRef: "my-s3"`（不使用 `type:'oss'`）
4. 创建 Sandbox → applicator 检查有效期 → `toPodSpec()` 注入 JSON 到 `secretMounts`
5. 进入容器，`cat /run/secrets/s3/my-s3.json` 确认内容完整
6. `curl "$(jq -r '.listUrl' /run/secrets/s3/my-s3.json)"` 确认可以列举 bucket

---

## 12. 实现顺序

自底向上，按依赖关系排列：

1. **删除旧代码** — BucketKeyBinding、generateS3KeyPair、autoGenerateKeys、bucketMounts、OSS case、health-check 过期扫描、queue consumer handleBucketKeyRotate
2. **类型层** — `src/core/security/types.ts` 新建；`src/features/sandbox/types.ts` 加 `SecurityResourceRef`；`src/features/template/types.ts` 加 `securityRef`
3. **IS3Provider** — `getPresignedUrl` / `putPresignedUrl` 去掉 `?`
4. **SecurityResourceService** — `src/core/security/service.ts` 新建
5. **applicator.ts** — 清除 bucketMounts + OSS 逻辑；新增 securityRef 解析 + 有效期检查
6. **sandbox.service.ts** — 删除 key generation；`toPodSpec()` 加 securityMounts
7. **pod/types.ts + pod/service.ts** — PodSpec 加 secretMounts + podSpecToGroupInput 透传
8. **eci-codec.ts** — `buildCreateParams()` + `buildPodCreateParams()` 处理 secretMounts（先确认 ECI ConfigFileVolume API）
9. **event-loop** — 自动刷新 tick 注册
10. **API** — `src/features/security/` feature 新建（handler + schema + response + index）
11. **验证** — typecheck → lint → test → map
