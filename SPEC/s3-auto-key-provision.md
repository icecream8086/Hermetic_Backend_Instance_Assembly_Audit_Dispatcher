# S3 存储桶自动密钥对生成与管理

> **⚠️ DEPRECATED** — 已被 `SPEC/security-resource-presigned-spec.md` 取代。
> AK/SK 密钥对方案已废弃，改为预签名 URL 方案。

## 需求

Bucket 实体增加一个开关。打开后，只要有沙箱引用该存储桶，系统就：
1. **自动生成**一对随机 AK/SK
2. **注入**到容器内（文件挂载）
3. **自动回收**（沙箱销毁时删除密钥）
4. **定期轮转**（容器可能向 S3 写回数据，密钥不能长期有效）

密钥由系统管理，不绑定 MinIO Admin API / IAM。权限取决于 bucket 自身的配置（public-read / bucket policy）。

## 设计

### 1. Bucket 实体扩展

**`src/core/region/bucket.ts`** — `RegionBucket` 新增字段：

```typescript
interface RegionBucket {
  // ...现有字段
  /** 引用此 bucket 的沙箱是否自动生成 S3 访问密钥对。 */
  readonly autoGenerateKeys?: boolean;
}
```

API 类型同步添加（`CreateBucketBody` / `UpdateBucketBody`）。

### 2. 新增记录：BucketKeyBinding

每条绑定记录跟踪一对已签发的密钥：

```typescript
interface BucketKeyBinding {
  sandboxId: string;
  bucketId: string;
  secretId: string;        // ContainerSecret ID（inline, value="AK:SK"）
  accessKeyId: string;     // 随机生成的 AK（用于日志/追踪，不用于吊销）
  version: number;         // 轮转版本
  expiresAt: number;       // 过期时间戳（创建/轮转时设定）
  createdAt: number;
}
```

Key: `bucket-key:{sandboxId}`
Index: `bucket-key:ids`（用于调度器扫描过期密钥）

### 3. 签发流程（SandboxService.provision）

```
provision(input):
  // 现有逻辑...

  // 处理 bucket 引用
  for each bucketMount in input.bucketMounts:
    if bucket.autoGenerateKeys:
      ak = random AK (12 字符前缀 + UUID)
      sk = random 32 字节 hex
      secret = ContainerSecretService.create({
        name: `s3-${bucketId}-${sandboxId}`,
        type: 'inline',
        value: `${ak}:${sk}`
      })
      binding = { sandboxId, bucketId, secretId: secret.id, accessKeyId: ak,
                  version: 1, expiresAt: now + rotationInterval, createdAt: now }
      atomic.set("bucket-key:" + sandboxId, binding)
      atomic.set("bucket-key:ids", [...ids, sandboxId])

      // 注入到容器
      providerInput.secretMounts.push({
        mountPath: "/run/secrets/s3-credentials",
        data: `${ak}:${sk}`
      })
```

### 4. 回收流程（SandboxService.delete）

```
delete(id):
  // 现有逻辑...

  // 查绑定 → 清理密钥
  binding = atomic.get("bucket-key:" + id)
  if binding:
    ContainerSecretService.delete(binding.secretId)
    atomic.set("bucket-key:" + id, null)
    idx.remove(id)
```

### 5. 轮转（定时任务）

通过 event-loop tick 检查过期密钥：

```
每 tick:
  idx = atomic.get("bucket-key:ids")
  for sandboxId in idx:
    binding = atomic.get("bucket-key:" + sandboxId)
    if binding.expiresAt < now:
      // 签发新密钥
      sk = random 32 字节 hex
      secret = ContainerSecretService.update(binding.secretId, { value: `${binding.accessKeyId}:${sk}` })
      binding.version++
      binding.expiresAt = now + rotationInterval
      atomic.set("bucket-key:" + sandboxId, binding)

      // 更新容器运行时（通过 provider 支持？还是等下次重启？）
      // 初始版本：仅更新 secret 存储，容器下次重启自动拿到新密钥
```

轮转间隔默认 24h（可配置 `BucketKeyBinding.rotationIntervalMs`）。

### 6. 容器内使用

注入到 `/run/secrets/s3-credentials`，格式 `AK:SK`：

```bash
IFS=: read -r S3_ACCESS_KEY S3_SECRET_KEY < /run/secrets/s3-credentials
rm -f /run/secrets/s3-credentials

# 配置 rclone
rclone config create my-s3 s3 access_key_id "$S3_ACCESS_KEY" secret_access_key "$S3_SECRET_KEY" ...

# 或直接用 aws-sdk / s3cmd
export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY"
```

容器不感知密钥是自动生成的还是手动配置的——读取同一路径。

补充写入 `SECRET_DIR/s3-endpoint`（bucket 的 endpoint），`SECRET_DIR/s3-region` 等元信息供容器配置 S3 客户端。

### 7. applicator 修复

`TemplateStorage.bucketId` 当前是死代码。需要改为：

```typescript
case 'oss':
case 有 bucketId 的引用:
  // 解析 bucket 实体 → 获取 endpoint/region/bucket.metadata
  // 将信息传递到 CreateSandboxInput.bucketMounts[]
```

## 触发开关

autoGenerateKeys 的配置在 Bucket 实体上，由用户通过 API 设置：

```http
POST /api/topology/buckets
{
  "name": "game-saves",
  "bucketType": "minio",
  "instanceId": "inst_xxx",
  "autoGenerateKeys": true
}
```

之后任何引用此 bucket 的模板/沙箱都会自动触发密钥签发。

## 变更清单

### 新增文件
- `specs/s3-auto-key-provision.md` — 本文

### 修改文件
| 文件 | 变更 |
|------|------|
| `src/core/region/bucket.ts` | RegionBucket + CreateBucketInput + UpdateBucketInput 加 `autoGenerateKeys` |
| `src/features/topology/types.ts` | Create/UpdateBucketBody 加 `autoGenerateKeys` |
| `src/features/topology/handler.ts` | 透传 `autoGenerateKeys`，修复错误消息 bug |
| `src/features/sandbox/types.ts` | CreateSandboxInput 加 `bucketMounts?` |
| `src/features/sandbox/sandbox.service.ts` | provision 签发、delete 回收、轮转 |
| `src/features/template/types.ts` | TemplateStorage 明确 bucketId 用途 |
| `src/features/template/applicator.ts` | 实现 bucketId 解析 → bucketMounts |
| `src/features/container-secret/service.ts` | 无变更（复用现有 CRUD） |
| `src/core/event-bus/loop.ts` | 或 app.ts 增加定期轮转回调 |
