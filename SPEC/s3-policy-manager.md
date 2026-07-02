# S3 策略管理器设计

> **⚠️ DEPRECATED** — 已被 `SPEC/security-resource-presigned-spec.md` 取代。
> MinIO IAM 策略方案已废弃，改为预签名 URL 方案。

## 目标

- 一套低耦合策略管理器，绑定到具体 S3 实例/存储桶
- 策略管理是管理员权限，容器拉取自己的密钥对是普通权限
- 策略可以翻译为 MinIO IAM / OSS RAM 语法
- 对接现有 `PermissionService`（用 `check()` 做鉴权）

## 设计

### 1. S3Policy 实体

每个 policy 绑定到一个 bucket，定义该 bucket 上允许的操作范围：

```typescript
interface S3Policy {
  id: string;
  bucketId: string;          // 绑定的存储桶
  name: string;
  description?: string;
  effect: 'Allow' | 'Deny';
  /** S3 action 列表: "s3:GetObject", "s3:PutObject", "*" 等 */
  actions: string[];
  /** 路径前缀限制: "games/*/saves/" 等。空字符串 = 全部 */
  pathPrefix: string;
  /** 应用到自动生成的密钥对（autoGenerateKeys 流程使用） */
  applyToAutoKeys: boolean;
  priority: number;          // 多条 policy 时的优先级
  createdAt: number;
  updatedAt: number;
}
```

### 2. S3PolicyManager

独立的模块，只依赖 `IAtomicStore`，不直接依赖 PermissionService：

```typescript
// src/core/s3-policy/manager.ts
class S3PolicyManager {
  constructor(private readonly atomic: IAtomicStore) {}

  async create(bucketId, input): Promise<S3Policy>
  async list(bucketId): Promise<S3Policy[]>
  async delete(id): Promise<void>
  async resolve(bucketId): Promise<S3Policy | null>
    // 合并 bucket 上所有 applyToAutoKeys=true 的 policy，
    // 按 priority 排序，Deny 覆盖 Allow
}
```

CRUD 本身不做鉴权——由调用方（HTTP handler）负责检查权限。

### 3. Policy → Provider 策略翻译

```typescript
// src/core/s3-policy/translate.ts

/** 合并多条 policy → MinIO IAM JSON */
function toMinioPolicy(policies: S3Policy[], bucketName: string): string;

/** 合并多条 policy → OSS RAM Policy */
function toOssPolicy(policies: S3Policy[], bucketName: string): string;
```

### 4. 和 PermissionService 的对接

两个层面的权限控制：

#### 4a. 策略 CRUD（管理员）

在 HTTP handler 里调用 `FeatureDeps.permissionChecker.check()`：

```typescript
router.post('/s3-policies', async (c) => {
  const user = c.var.currentUser;
  const result = await permChecker.check({
    userId: user.id,
    action: 'admin',
    resource: 's3-policy',
  });
  if (!result.allowed) return c.json(fail('FORBIDDEN', 'Admin access required'), 403);

  const policy = await policyMgr.create(body.bucketId, body);
  return c.json(ok(policy), 201);
});
```

需要先在 PermissionService 里注册一条 rule：
```
effect: allow, action: admin, resource: s3-policy, priority: 80
```

#### 4b. 密钥对获取（普通用户）

sandbox provision 时检查用户对沙箱的权限：

```typescript
// 在 SandboxService.provision() 中，生成密钥前：
const permResult = await permChecker?.check({
  userId: input.creatorId!,
  action: 'create',
  resource: `sandbox:${sandboxId}`,
  resourceOwnerId: input.creatorId,
});
if (permResult && !permResult.allowed) throw new AppError(403, ...);
```

现有的 daemon template 已有 `allow: create sandbox:$self`，普通用户也有权限。

#### 4c. 低耦合设计

- `S3PolicyManager` 不引用 `PermissionService`，职责单一
- Permission check 在 handler 层做，通过 `FeatureDeps.permissionChecker`（就是 `PermissionService.check` 的封装）
- 如果当前请求没有 permissionChecker（dev 模式关闭 auth），policy CRUD 直接放行
- 这种模式和你现有的 volume handler 里的 `requireRoot()` 完全一致

### 5. 和 autoGenerateKeys 流程的集成

```
Bucket { autoGenerateKeys: true }
  ↓
SandboxService.provision()
  → resolver 拿到 IIamProvider
  → policyMgr.resolve(bucketId)  // 拿到 bucket 上的有效 policy
  → IIamProvider.createAccessKey({
      parentUser: adminAk,
      policy: toMinioPolicy(policies, bucketName)
    })
  → 返回 scope 好的 AK/SK（只配读指定路径）
  → 注入容器
```

没配置 policy 时走默认——autoGenerateKeys 降级为全部读写在当前 bucket 内。

### 6. 位置

新建 `src/core/s3-policy/`：

| 文件 | 内容 |
|------|------|
| `types.ts` | `S3Policy`、`CreateS3PolicyInput` |
| `manager.ts` | `S3PolicyManager`（CRUD + resolve） |
| `translate.ts` | `toMinioPolicy()`、`toOssPolicy()` |

策略 CRUD 的 HTTP handler 放在已有的 `features/topology/handler.ts` 里或新建 `features/s3-policy/`。

## 权限关系矩阵

| 操作 | 所需 action | 资源 | 典型角色 |
|------|-----------|------|---------|
| 创建/编辑/删除 policy | `admin` | `s3-policy` | root, Operator |
| 查看 policy | `read` | `s3-policy` | viewer, Operator |
| 自动生成密钥对 | `create` | `sandbox:{id}` | 普通用户（sandbox 创建者） |

## 和 MinIO Admin API 的关系

```
CredentialService
  └─ credentialRef → findByName("minio-admin")
       → accessKeyId: "minioadmin", accessKeySecret: "minioadmin"
       → 用这组凭据签名 MinIO Admin API 请求

IIamProvider.createAccessKey({ parentUser, policy })
  └─ POST /minio/admin/v3/add-service-account
     SigV4 签名（复用 S3ClientBase.authFetch）
     Body: { parentUser: "minioadmin", policy: "{...}" }
     → 返回 scope 好的 AK/SK
```

## 实现估算

- `src/core/s3-policy/types.ts` + `manager.ts` + `translate.ts` — ~150 行
- `MinioIamProvider` — ~80 行（复用 `S3ClientBase`）
- Handler 挂载到 topology 或独立 feature — ~50 行
- 测试 — ~100 行

总计约 **350-400 行**，全是新文件，不破坏现有代码。
