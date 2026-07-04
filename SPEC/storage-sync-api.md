# S3 存储同步 REST API v1

> **Status**: Draft
> **日期**: 2026-07-04
> **依赖**: Worker S3 控制面 (JWT + 按需签名), 现有权限系统

---

## 0. 场景

用户有一批本地文件需要同步到 S3。客户端对比本地和远程差异，按用户指令单向覆盖上传。不上传的删远程，不下载，不开放编辑。

**类比**: OneDrive "上传模式"，没有离线缓存、没有版本历史、没有分享链接。

---

## 1. API 总览

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/storage/{bucket}/files` | 列出文件（含 metadata sha256） |
| `POST` | `/api/storage/{bucket}/diff` | 差异比较（本地 manifest vs S3） |
| `POST` | `/api/storage/{bucket}/presign` | 签发 PUT URL（含 x-amz-meta-sha256） |
| `DELETE` | `/api/storage/{bucket}/files/{key}` | Worker 代理删除 S3 对象 |

---

## 2. 认证

复用现有权限系统。用户登录后持有 session JWT，调 Worker API 时带 `Authorization: Bearer <jwt>`。

路由 ACL：

| 操作 | action | resource | 说明 |
|---|---|---|---|
| 列举文件 | `read` | `storage:{bucket}` | 所有组内用户 |
| 差异比较 | `read` | `storage:{bucket}` | 同列举 |
| 签发 PUT URL | `write` | `storage:{bucket}/{prefix}` | 组内写入者 |
| 删除文件 | `delete` | `storage:{bucket}/{prefix}` | 组内管理员 |

Worker 在每个端点入口验证用户对 `{bucket}/{key前缀}` 的权限。

---

## 3. 端点详细设计

### 3.1 `GET /api/storage/{bucket}/files`

```
Query: prefix?, limit? (max 1000), continuationToken?
Response: {
  files: [{ key, size, sha256, lastModified }],
  nextContinuationToken?,
  isTruncated: boolean
}
```

Worker 行为：
1. 验证用户有 `read:storage:{bucket}` 权限
2. 调 S3 `listObjects(bucket, { prefix, maxKeys, continuationToken })`
3. 对于每个对象，用 `headObject` 获取 `x-amz-meta-sha256`（或 listObjectsV2 直接返回 metadata）
4. 返回 JSON

**sha256 为 `null` 表示对象上传时未附带 sha256（旧数据）**。

### 3.2 `POST /api/storage/{bucket}/diff`

```
Body: {
  files: [{ key: string, sha256: string, size: number }]   // 最多 10000 个
}
Response: {
  toUpload:  [{ key, sha256, size }],   // 新增 + 变更
  unchanged: [{ key }],                 // 本地和远程一致
  orphaned:  [{ key }],                 // S3 上有，但 manifest 里没有
}
```

Worker 行为：
1. 验证用户有 `read:storage:{bucket}` 权限
2. 调 S3 listObjects，获取完整文件列表 + metadata sha256
3. 构建 `Map<key, { sha256, size }>` 从 S3 端
4. 对 manifest 中每个文件：
   - S3 不存在 → `toUpload`
   - S3 sha256 与本地不同 → `toUpload`
   - S3 sha256 相同 → `unchanged`
5. S3 有但 manifest 没有 → `orphaned`
6. 返回三类列表

**复杂度**: O(n) 哈希查找，单次 Worker 请求内完成。

### 3.3 `POST /api/storage/{bucket}/presign`

```
Body: {
  file: { key: string, sha256: string, size: number },
  ttl?: number   // 默认 300 (5min), 最大 3600
}
Response: {
  url: string,           // presigned PUT URL，已签名 x-amz-meta-sha256 header
  bucket: string,
  key: string,
  expiresAt: string,
  headers: {             // 客户端 PUT 时必须附带的 header
    "x-amz-meta-sha256": string,
    "Content-Type": string,
    "Content-Length": string
  }
}
```

Worker 行为：
1. 验证用户有 `write:storage:{bucket}/{key}` 权限
2. 调 S3 `putPresignedUrl(bucket, key, ttl)`，签名时包含 `x-amz-meta-sha256` header
3. 返回 URL + 客户端必须携带的 header 列表

**客户端 PUT 流程**:
```
curl -X PUT "$url" \
  -H "x-amz-meta-sha256: $sha256" \
  -H "Content-Type: application/octet-stream" \
  -H "Content-Length: $size" \
  --data-binary @local-file
```

**每次上传前重新签一个 URL。** 不存在长 URL 缓存。5 分钟足够 PUT 一个文件。

### 3.4 `DELETE /api/storage/{bucket}/files/{key}`

Worker 行为：
1. 验证用户有 `delete:storage:{bucket}/{key}` 权限
2. 调 S3 `deleteObject(bucket, key)`
3. 返回 200（无论 key 是否存在——S3 delete 幂等）

---

## 4. 客户端流程

```
1. 用户登录 → 拿到 session JWT
2. 用户选择本地文件夹 → 客户端计算所有文件 [{key, sha256, size}]（路径转 key）
3. POST /diff → 拿到 {toUpload, unchanged, orphaned}
4. 展示差异：
   ┌──────────────────────────────────────────┐
   │  新增:    3 个文件                        │
   │  已变更:  2 个文件                        │
   │  未变更:  147 个文件                      │
   │  仅远程:  1 个文件 (可清理)               │
   │                                          │
   │  [同步上传]  [清理远程]                   │
   └──────────────────────────────────────────┘
5. 用户点击 [同步上传]:
   for each file in toUpload:
     POST /presign → PUT to S3
6. 用户点击 [清理远程]:
   for each file in orphaned:
     DELETE /files/{key}
7. 更新本地 manifest，下次 diff 用
```

---

## 5. 权限模型

| 角色 | 列举 | 上传 | 删除 | 适用 |
|---|---|---|---|---|
| viewer | ✅ 自己 bucket | ❌ | ❌ | 看文件列表 |
| member | ✅ | ✅ | ❌ | 上传文件 |
| manager | ✅ | ✅ | ✅ | 上传 + 清理 |

通过 `PermissionService` 注册规则：

```
allow: read   storage:{bucket}  viewer/member/manager
allow: write  storage:{bucket}  member/manager
allow: delete storage:{bucket}  manager
```

---

## 6. 与现有系统关系

```
             Worker S3 控制面 (已有)
                    │
    ┌───────────────┼───────────────┐
    │               │               │
    ▼               ▼               ▼
/presign         /list             (容器内 S3 JWT 路径)
(容器用 +       (容器用 +
 客户端用)       客户端用)
    │               │
    └───────┬───────┘
            │
            ▼
    /api/storage/{bucket}/*   ← 新增：客户端存储同步 API
      │
      ├── GET  /files           ← 包装 listObjects
      ├── POST /diff            ← listObjects + 对比
      ├── POST /presign         ← 复用 getPresignedUrl / putPresignedUrl
      └── DELETE /files/{key}   ← 代理 deleteObject
```

不创建新实体。复用现有 `IS3Provider` 方法、SecurityResource 作为 bucket 访问策略（JWT claims 包含允许的 bucket/prefix）、用户认证系统。

---

## 7. 实现

### Phase 1 — S3 list 增强

`IS3Provider.listObjects()` 返回 metadata（x-amz-meta-*）。当前 `S3ObjectInfo` 接口需要确认是否包含 `metadata` 字段。如不含，新增。

### Phase 2 — 存储路由

**新建** `src/features/storage/`:

| 文件 | 内容 |
|---|---|
| `schema.ts` | `DiffRequest`, `PresignForSyncRequest` Zod schemas |
| `response.ts` | `ListResponse`, `DiffResponse`, `PresignResponse` schemes |
| `handler.ts` | 4 个端点 |
| `index.ts` | Feature 注册 |

### Phase 3 — 权限规则

`PermissionService` 注册 `storage:{bucket}` 资源类型和 route ACL。

### Phase 4 — metadata 签名

`IS3Provider.putPresignedUrl()` 签名时附加 `x-amz-meta-sha256` header。三个实现（AWS S3、Alibaba OSS、Cloudflare R2）各自适配。

---

## 8. 局限

| 局限 | 说明 |
|---|---|
| 大文件 sha256 计算 | 客户端需在签名前计算整个文件的 sha256——文件越大越慢。可接受。 |
| 10000 文件上限 | `POST /diff` 单次最多 10000 个文件。超过需分批。 |
| presigned PUT 必须匹配 Content-Length | 客户端必须预先知道文件大小且传入 `Content-Length` header |
| Worker 不负责上传本身 | 只负责签发 URL。上传带宽 = S3 endpoint 直连带宽，不经 Worker。 |
