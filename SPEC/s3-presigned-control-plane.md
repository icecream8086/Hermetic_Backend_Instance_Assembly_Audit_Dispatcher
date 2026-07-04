# S3 预签名控制面 — 整合规范 v3

> **Status**: Draft
> **日期**: 2026-07-04
> **取代**: `SPEC/security-resource-presigned-spec.md` (v2)

---

## 0. 为什么 v2 不够

v2 的 `SecurityResource` 在 sandbox provision 时一次性签发一组 presigned URL 注入容器。这有四个致命缺陷：

| 缺陷 | 详情 |
|---|---|
| **PUT URL 形同虚设** | `putUrl` 签给 `_placeholder_` key。容器要写 `my-file.txt` 时替换 key → S3 SigV4 签名失效。写入能力是假的。 |
| **无法读取单个对象** | 只注入了 `listUrl`（bucket-level）。没有 `getUrl`——因为不知道容器要读哪个 key。 |
| **多文件=灾难** | 读 1000 个小文件需要先调 Worker API 拿 URL，再调 S3。2000 个往返。v2 的"多对象读取"段落把问题描述为"后续方案"，实际上不解决就没法用。 |
| **URL 不可吊销** | S3 presigned URL 一旦签发，服务端无法撤销。发现恶意操作只能等 URL 自然过期（15 分钟窗口）。 |

**核心洞察**：不能预先生成 URL 扔进容器，必须在容器**需要时按 key 签名**。需要签名的代码路径在 Worker 上，不在容器里。

---

## 1. 架构

```
                        Sandbox provision
                       ┌──────────────────┐
                       │ 签发 JWT token   │
                       │ (claims: sandbox │
                       │  id, buckets,    │
                       │  prefixes, exp)  │
                       └────────┬─────────┘
                                │ 注入 /run/secrets/s3/token
                                ▼
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│   容器        │──control──▶   Worker     │──data──▶│    S3        │
│              │  JWT auth    │  (控制面)    │  presigned │  (数据面)    │
│              │◀────────────│             │  URL       │              │
│              │  presigned  │  sign/batch │            │              │
│              │  URL/list   │  sign/list  │            │              │
└──────────────┘       └──────────────┘       └──────────────┘
                               │                       ▲
                               │                       │
                               │              ┌───────┴───────┐
                               │              │  容器直接用    │
                               │              │  presigned URL │
                               │              │  读写 S3       │
                               │              └───────────────┘
```

**控制面**（Worker）: JWT 鉴权 + 按需签发 presigned URL + list 代理（解析 XML→JSON）。
**数据面**（S3 直连）: 容器拿到 URL 后直接 curl S3，不经 Worker。

### 1.1 与 v2 对比

| | v2 (SecurityResource) | v3 (控制面) |
|---|---|---|
| 容器凭据 | 预签名 URL JSON | 短期 JWT token |
| URL 生成 | 启动时一次性签发 | 按需签发（per-key） |
| 多对象读取 | 不存在（需"后续方案"） | 批量签名 + 并行下载 |
| 写入任意 key | 不可用（placeholder bug） | 按需 PUT 签名 |
| 吊销 | 不可能（S3 URL 无法撤销） | 终止沙箱 → JWT 超时后不可续期 |
| URL 刷新 | event-loop 每 5 分钟扫描 | 不需要——JWT 无状态，URL 短期按需 |
| list 结果格式 | XML（需容器解析） | JSON（Worker 解析） |

---

## 2. JWT 设计

### 2.1 签发时机与生命周期

```
SandboxService.provision()
  → toPodSpec() 生成 JWT token
  → 通过 secretMounts 注入 /run/secrets/s3/token

JWT 有效期: 1 小时（与 Sandbox 生命周期对齐）
JWT 不刷新: 沙箱最长生命周期通常在数小时级别，1h JWT 过期时沙箱大概率已终止。
            下轮 provision 直接发新 JWT。
吊销路径: 终止沙箱 → JWT 剩余有效期过后自然失效。
         复合窗口 = JWT 剩余 + presigned URL 有效期。
         最坏: 60min + 5min = 65min。典型: 几分钟（发现异常 → terminate → 等 URL 过期）。
```

### 2.2 Claims

```typescript
interface S3AccessToken {
  /** JWT ID（日志/审计追踪，非吊销用） */
  jti: string;
  /** 签发者 — Worker 自身 domain */
  iss: string;
  /** 主体 — sandboxId */
  sub: string;
  /** 签发时间（Unix 秒） */
  iat: number;
  /** 过期时间（Unix 秒）。默认 3600。 */
  exp: number;
  /** 授权列表 */
  grants: readonly {
    /** Bucket 名称 */
    bucket: string;
    /** 允许的 key 前缀。空字符串 = 无限制。 */
    prefix: string;
    /** 允许的操作 */
    permissions: readonly ('read' | 'write' | 'list')[];
  }[];
}
```

### 2.3 签发者

**Worker 自签发**。JWT 密钥只存在于 Worker 环境变量中，不扩散到控制面（app.ts）。

容器启动时不调 Worker——`SandboxService.provision()` 生成 JWT 需要密钥。两个方案：

| 方案 | 描述 |
|---|---|
| **共享密钥**（推荐 v1） | JWT secret 存在 KV `_sys:jwt-secret`。app.ts 用 `jose` 或 `node:crypto` HS256 签发。Worker 验证端点从同一个 KV 读。密钥 rotation：写新 key，旧 key 保留到所有 token 过期。 |
| **Worker 签发端点** | `POST /api/token` 用 podUid + 预共享 secret 换 JWT。多一次启动请求。v2 考虑。 |

**选共享密钥**。简单，免去容器启动时的额外 HTTP 调用。

### 2.4 废除刷新机制

删除 `src/core/events/security-refresh.ts`。JWT 不刷新，URL 按需重新签名故无需后台续期。

---

## 3. Worker API 端点

现有 `GET/POST/DELETE /api/security` CRUD 端点保留（管理 SecurityResource 策略实体）。

新增三个**面向容器**的端点：

### 3.1 `GET /api/security/presign`

```
Query: bucket, key, method=GET|PUT
Header: Authorization: Bearer <jwt>

Worker:
  1. 验证 JWT 签名 + exp
  2. 检查请求的 (bucket, key) 是否在 grants 范围内
     - 至少有 'read'（GET）或 'write'（PUT）权限
     - key 前缀匹配 grants[].prefix
  3. 调用 s3Provider.getPresignedUrl() 或 putPresignedUrl()
     URL 有效期: 5 分钟（硬编码，可在 SecurityResource 实体上可配置）
  4. 返回 { url, expiresAt }

Status: 200 | 401(过期/无 token) | 403(权限不足) | 503(S3 不可达)
```

### 3.2 `POST /api/security/batch-presign`

```
Body: { files: [{ bucket, key, method }] }
Limit: 100 项/次
Header: Authorization: Bearer <jwt>

Worker:
  1. 验证 JWT
  2. 逐项鉴权（bucket/prefix/permission）
  3. 并发签发所有 URL（Promise.all）
  4. 返回 { urls: [{ key, url, expiresAt }] }

超过 100 项 → 400。容器需自行分批。
```

约束：Worker 的 SigV4 签名是纯本地计算（不产生子请求），100 次签名在 30s CPU 预算内安全。

### 3.3 `GET /api/security/list`

```
Query: bucket, prefix?, limit? (默认 1000, 最大 1000), continuationToken?
Header: Authorization: Bearer <jwt>

Worker:
  1. 验证 JWT + 鉴权（bucket + prefix + 'list' 权限）
  2. 调 s3Provider.listObjects(bucket, { prefix, maxKeys, continuationToken })
  3. 解析 S3 XML 响应 → JSON
  4. 返回 { files: [{key, size, lastModified}], nextContinuationToken?, isTruncated }

Status: 200 | 401 | 403 | 503
```

容器分页：拿到 `nextContinuationToken` 后下次请求带上。分页请求必须串行（S3 continuation token 的约束）。

---

## 4. 数据模型变更

### 4.1 SecurityResource → StorageAccessPolicy

当前 `SecurityResource` 存的是 presigned URL 缓存。v3 改为存**访问策略**——定义哪个 bucket/prefix 允许什么操作。URLs 是动态产物，不再持久化。

```typescript
// src/core/security/types.ts

export interface PresignedUrlSet {
  /** 删除 —— 不再预先缓存 URL */
}

export interface SecurityResource {
  readonly id: SecurityResourceId;
  readonly name: string;
  /** 关联的 S3 存储桶 ID */
  readonly bucketId: string;
  readonly instanceId: InstanceId;
  /** JWT token 有效期（秒）。默认 3600（1h）。 */
  readonly tokenTtl: number;
  /** 按需签发的 presigned URL 有效期（秒）。默认 300（5min）。 */
  readonly presignedUrlTtl: number;
  /** Bucket + key 前缀白名单。每个 entry 定义一组前缀的读写权限。 */
  readonly accessPolicy: readonly StorageAccessEntry[];
  readonly status: SecurityResourceStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface StorageAccessEntry {
  /** 允许的 key 前缀。空字符串 = bucket 下全路径。 */
  readonly prefix: string;
  /** 允许的操作 */
  readonly permissions: readonly ('read' | 'write' | 'list')[];
}
```

删除字段：
- `value: PresignedUrlSet` —— 不再需要，URLs 按需动态签发
- `validDuration` → 重命名为 `tokenTtl`（语义变了）
- `refreshThreshold` —— JWT 不刷新，该字段无意义

### 4.2 TemplateStorage.securityRef → securityRefs

单值 `string | undefined` 改为 `string[]`，支持一个模板声明多个存储策略引用。

```typescript
// src/features/template/types.ts — TemplateStorage 中

/** @deprecated 单值引用 —— 被 securityRefs 替代 */
readonly securityRef?: string | undefined;
/** 引用多个 SecurityResource 的名称。 */
readonly securityRefs?: readonly string[] | undefined;
```

applicator 解析时两者都支持，单值标记 `@deprecated`。

### 4.3 CreateSandboxInput.securityResources

类型从 `SecurityResourceRef[]`（含 presigned URL 快照）改为 `JwtTokenContext`：

```typescript
// src/features/sandbox/types.ts

export interface SandboxStorageAccess {
  /** JWT token（已签发，claims 含所有授权信息） */
  readonly token: string;
  /** 过期时间（ISO 8601），供容器感知 */
  readonly expiresAt: string;
}
```

### 4.4 删除 SecurityResourceRef

当前类型 `SecurityResourceRef`（含 `resourceId`, `resourceName`, `value: PresignedUrlSet`）整体删除。容器内不再按 `resourceName` 分文件——只有一个 `/run/secrets/s3/token`。

---

## 5. 实现变更清单

### 5.1 修改文件

| 文件 | 变更 |
|---|---|
| `src/core/security/types.ts` | 重写：`SecurityResource` 字段变更（删 value, validDuration, refreshThreshold；加 accessPolicy, tokenTtl, presignedUrlTtl）；删 `PresignedUrlSet` |
| `src/core/security/service.ts` | 重写 `provision()`——不再生成 URL；新增 `issueToken(resource, sandboxId)`——用共享密钥签发 JWT |
| `src/features/security/handler.ts` | 新增 3 个容器端点：`GET /presign`, `POST /batch-presign`, `GET /list`；CRUD 端点保留 |
| `src/features/security/schema.ts` | 新增 `PresignRequest`, `BatchPresignRequest`, `ListRequest` Zod schemas |
| `src/features/template/applicator.ts` | `securityRef` → `securityRefs`；不再查 `checkValidity()`；查询策略存在即可 |
| `src/features/template/types.ts` | `TemplateStorage.securityRef` 标记 `@deprecated`；新增 `securityRefs` |
| `src/features/sandbox/types.ts` | 删 `SecurityResourceRef`；`securityResources` 类型改为 `SandboxStorageAccess` |
| `src/features/sandbox/sandbox.service.ts` | `toPodSpec()`：JWT 签发（读 KV `_sys:jwt-secret` + 查 SecurityResource 策略 → 生成 JWT → 注入 `/run/secrets/s3/token` 单一文件） |

### 5.2 新增文件

| 文件 | 内容 |
|---|---|
| `src/core/security/jwt.ts` | JWT 签发（HS256） + 验证函数。依赖 `IAtomicStore` 读密钥。 |
| `src/core/security/middleware.ts` | Worker 端 JWT 验证中间件（复用于 presign/batch/list 端点） |

### 5.3 删除文件/模块

| 文件/模块 | 原因 |
|---|---|
| `src/core/events/security-refresh.ts` | JWT 不刷新，URL 按需签发 |
| `src/core/security/types.ts` 中 `PresignedUrlSet` | 不再预先缓存 URL |
| `src/features/sandbox/types.ts` 中 `SecurityResourceRef` | 被 `SandboxStorageAccess` 替代 |
| `app.ts:170-182` 中 `registerSecurityRefresh()` 调用 | 刷新机制废除 |
| `src/features/topology/response-schema.ts:43` 中 `autoGenerateKeys` | v1 残留字段，本次清理 |

### 5.4 不改的文件

| 文件 | 说明 |
|---|---|
| `src/core/provider/s3.ts` — `IS3Provider.getPresignedUrl/putPresignedUrl` | 保持不变。Worker 的 presign 端点用同样方法。 |
| `src/providers/alibaba/eci-codec.ts` | `ConfigFileVolume` 编码保持不变。只注入一个文件（token 而非多个 URL JSON） |
| `src/core/pod/types.ts` — `secretMounts` | 字段保留，透传到提供商。 |
| `src/providers/podman/podman-provider.ts` | secretMounts → tmpfs 路径保持不变。 |
| `src/features/generated.ts` | security feature 已注册，无需改。 |
| `app.ts:413` — `s3ProviderResolver` | 保留。`POST /presign` 和 `GET /list` 需要解析 S3 provider。 |

---

## 6. 注入契约

### 6.1 文件

容器内**唯一** S3 相关文件：

```
/run/secrets/s3/token    ← JWT token（纯文本，HS256）
```

不再有 `/run/secrets/s3/{name}.json`（多个 URL JSON 文件）。

### 6.2 容器内使用

```bash
#!/bin/sh
TOKEN=$(cat /run/secrets/s3/token)
rm -f /run/secrets/s3/token  # 读后即焚

# 按需读取文件
URL=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://worker/api/security/presign?bucket=game-saves&key=save-001.dat&method=GET" \
  | jq -r '.url')
curl -s -o /tmp/save.dat "$URL"

# 批量读取
URLS=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://worker/api/security/batch-presign" \
  -H "Content-Type: application/json" \
  -d '{"files":[{"bucket":"game-saves","key":"a.bin","method":"GET"}]}')
echo "$URLS" | jq -r '.urls[].url' | xargs -P 10 -I{} curl -s -O {}

# 写入
PUT_URL=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://worker/api/security/presign?bucket=game-saves&key=result.json&method=PUT" \
  | jq -r '.url')
curl -s -X PUT -T /tmp/result.json "$PUT_URL"

# 列举
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://worker/api/security/list?bucket=game-saves&prefix=save-" \
  | jq '.files'
```

---

## 7. 运维与安全边界

### 7.1 度量

Worker 端点应暴露至少以下指标：

| Metric | 类型 | 描述 |
|---|---|---|
| `jwt_validation_failures_total` | Counter | JWT 过期/签名失败次数 |
| `presign_requests_total` | Counter | 按 bucket 和 method 分组 |
| `presign_latency_ms` | Histogram | 签名耗时 |
| `list_requests_total` | Counter | list 请求量 |
| `s3_errors_total` | Counter | S3 后端调用失败次数 |

### 7.2 告警规则

| 条件 | 级别 | 描述 |
|---|---|---|
| `s3_errors_total` 速率 > 10/min | Warning | S3 provider 故障或凭证过期 |
| `jwt_validation_failures_total` 速率 > 50/min | Warning | 可能的过期 token 风暴或攻击 |
| `presign_latency_ms` p99 > 5000ms | Warning | 签名性能退化 |

### 7.3 安全风险矩阵

| 风险 | 等级 | 缓解 |
|---|---|---|
| JWT 被容器逃逸者窃取 | 中 | JWT 1h 过期；终止沙箱阻断后续滥用 |
| 已签发 presigned URL 被中间人截获 | 低 | URL 5min 过期，HTTPS 传输 |
| JWT secret 泄露 | 高 | KV 存储，仅 Worker + app.ts 访问；rotation 支持 |
| Worker 拒绝服务 | 中 | rate-limit per sandbox；batch-presign 限 100/次 |
| S3 预签名 URL 无法吊销 | **接受** | S3 物理限制。窗口 = URL TTL (5min) |

### 7.4 不解决的风险（需威胁模型接受）

- **S3 presigned URL 一旦签发，在 TTL 内无法主动撤销。** 终止沙箱只能阻止获取新 URL，已发出的 URL 仍有效。窗口 = 5 分钟。如果业务要求秒级阻断已发出的读取权限，需要放弃 S3 presigned，转向 CloudFront 签名 URL 或自建 MinIO。

---

## 8. 实现顺序

1. **类型层** — `src/core/security/types.ts` 重写（SecurityResource 新字段 + StorageAccessEntry）
2. **JWT 工具** — `src/core/security/jwt.ts` 新建（签发 + 验证）
3. **JWT 中间件** — `src/core/security/middleware.ts` 新建
4. **SecurityResourceService** — 重写，新增 `issueToken()`
5. **Worker API** — presign / batch-presign / list 端点
6. **applicator** — securityRef → securityRefs；删 SecurityResourceRef 引用
7. **sandbox.service** — toPodSpec 改为注入 `/run/secrets/s3/token`（JWT 单一文件）
8. **清理** — 删除 `security-refresh.ts`、`PresignedUrlSet`、`SecurityResourceRef`、`autoGenerateKeys` 残留
9. **验证** — `npm run typecheck && npm run lint && npm test && npm run map`

---

## 9. 已废弃文件

这些 SPEC 已被本方案取代，不再维护：

- `SPEC/s3-auto-key-provision.md` — AK/SK 密钥对方案
- `SPEC/s3-policy-manager.md` — MinIO IAM 策略方案
- `SPEC/security-resource-presigned-spec.md` — v2 presigned URL 一次性注入方案
