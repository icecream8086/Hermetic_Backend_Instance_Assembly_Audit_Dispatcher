# S3 多线程分片上传/下载 — 客户端开发指南

> 基于 `src/core/provider/s3.ts` 和 `src/features/topology/handler.ts`
> 支持 AWS S3 / Cloudflare R2 / Alibaba OSS / MinIO

---

## 1. 概述

服务端提供 multipart 编排 API + presigned URL 生成。客户端拿到 presigned URL 后直接用 HTTP PUT/GET 操作对象存储，不经过本项目后端。

**适用场景：**
- 上传 > 5 MB 的文件（单 PUT 不可恢复，分片可重试）
- 多线程并行加速上传/下载
- 断点续传

---

## 2. 分片上传流程

### Step 1: 创建上传会话

```
POST /api/topology/buckets/{bucketId}/uploads
Authorization: Bearer {admin-token}
Content-Type: application/json

{
  "key": "game-assets/v1.2.3/data.zip",
  "contentType": "application/zip",
  "partSize": 5242880,
  "parts": 4,
  "expiresIn": 3600
}
```

**参数说明：**

| 字段 | 必填 | 说明 |
|------|------|------|
| `key` | ✅ | 对象路径（Object Key） |
| `parts` | ✅ | 分片数量 |
| `contentType` | 否 | MIME 类型 |
| `partSize` | 否 | 每片大小（bytes），默认 5MB |
| `expiresIn` | 否 | presigned URL 有效期（秒），默认 3600 |

**响应：**

```json
{
  "success": true,
  "data": {
    "uploadId": "0004B9894A22E5B1888A1E29F823****",
    "bucket": "my-bucket",
    "key": "game-assets/v1.2.3/data.zip",
    "presignedUrls": [
      { "partNumber": 1, "url": "https://bucket.s3.region.amazonaws.com/key?X-Amz-..." },
      { "partNumber": 2, "url": "https://bucket.s3.region.amazonaws.com/key?X-Amz-..." },
      { "partNumber": 3, "url": "https://bucket.s3.region.amazonaws.com/key?X-Amz-..." },
      { "partNumber": 4, "url": "https://bucket.s3.region.amazonaws.com/key?X-Amz-..." }
    ],
    "partSize": 5242880,
    "expiresIn": 3600
  }
}
```

### Step 2: 并行上传分片

```python
import concurrent.futures
import requests

def upload_part(part_url, data):
    resp = requests.put(part_url, data=data)
    etag = resp.headers['ETag'].strip('"')
    return etag

with open('data.zip', 'rb') as f:
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        futures = {}
        for i, part_info in enumerate(presigned_urls):
            offset = i * part_size
            chunk = f.read(part_size)
            futures[executor.submit(upload_part, part_info['url'], chunk)] = part_info['partNumber']
        
        parts = []
        for future in concurrent.futures.as_completed(futures):
            pn = futures[future]
            etag = future.result()
            parts.append({'partNumber': pn, 'etag': etag})
```

```javascript
// JavaScript/TypeScript
const uploadPart = async (url, chunk) => {
  const resp = await fetch(url, { method: 'PUT', body: chunk });
  return resp.headers.get('ETag').replace(/"/g, '');
};

// 4 threads parallel
const parts = await Promise.all(
  presignedUrls.map(async ({ partNumber, url }, i) => {
    const offset = i * partSize;
    const chunk = file.slice(offset, offset + partSize);
    const etag = await uploadPart(url, chunk);
    return { partNumber, etag };
  })
);
```

### Step 3: 合并分片

```http
POST /api/topology/buckets/{bucketId}/uploads/{uploadId}/complete
Authorization: Bearer {admin-token}
Content-Type: application/json

{
  "key": "game-assets/v1.2.3/data.zip",
  "parts": [
    { "partNumber": 1, "etag": "abc123" },
    { "partNumber": 2, "etag": "def456" },
    { "partNumber": 3, "etag": "ghi789" },
    { "partNumber": 4, "etag": "jkl012" }
  ]
}
```

**partNumber 必须升序排列。** 响应：

```json
{ "success": true, "data": { "location": "https://..." } }
```

### 取消上传

```http
DELETE /api/topology/buckets/{bucketId}/uploads/{uploadId}
Content-Type: application/json

{ "key": "game-assets/v1.2.3/data.zip" }
```

### 查询已上传分片（断点续传）

```http
GET /api/topology/buckets/{bucketId}/uploads/{uploadId}/parts?key=game-assets/v1.2.3/data.zip
```

---

## 3. 分片下载流程

```http
GET /api/topology/buckets/{bucketId}/objects/{key}/download?partSize=5242880&parts=4&expiresIn=3600
Authorization: Bearer {admin-token}
```

**响应：**

```json
{
  "success": true,
  "data": {
    "bucket": "my-bucket",
    "key": "game-assets/v1.2.3/data.zip",
    "size": 20971520,
    "presignedUrls": [
      { "partNumber": 1, "url": "https://...?X-Amz-...&range=bytes%3D0-5242879", "range": "bytes=0-5242879" },
      { "partNumber": 2, "url": "https://...?X-Amz-...&range=bytes%3D5242880-10485759", "range": "bytes=5242880-10485759" },
      { "partNumber": 3, "url": "https://...?X-Amz-...&range=bytes%3D10485760-15728639", "range": "bytes=10485760-15728639" },
      { "partNumber": 4, "url": "https://...?X-Amz-...&range=bytes%3D15728640-20971519", "range": "bytes=15728640-20971519" }
    ]
  }
}
```

**客户端多线程下载：**

```javascript
const chunks = new Array(parts);
await Promise.all(
  presignedUrls.map(async ({ partNumber, url }) => {
    const resp = await fetch(url);
    const blob = await resp.blob();
    chunks[partNumber - 1] = blob;
  })
);
const file = new Blob(chunks);
```

---

## 4. Provider 差异

| 特性 | AWS S3 | Cloudflare R2 | Alibaba OSS | MinIO |
|------|:------:|:-------------:|:-----------:|:-----:|
| 分片上传 | ✅ | ✅ | ✅ | ✅ |
| 分片下载 | ✅ | ✅ | ✅ | ✅ |
| 预签名 URL 方案 | SigV4 | SigV4 | OSS native | SigV4 |
| 最小分片 | 5 MB | 5 MB | 100 KB | 5 MB |
| 最大分片数 | 10,000 | 10,000 | 10,000 | 10,000 |
| 最大对象大小 | 5 TB | 5 TB | 48.8 TB | 5 TB |

---

## 5. 错误处理

| HTTP | 说明 | 处理 |
|------|------|------|
| 404 | Bucket 不存在或对象不存在 | 检查 bucketId/key |
| 400 `NOT_SUPPORTED` | Provider 不支持该操作 | 检查 provider 配置 |
| 400 `VALIDATION_ERROR` | 缺少必填参数 | 检查请求 body |
| 500 | 上传/合并失败 | 重试；检查 presigned URL 是否过期 |

**分片重试策略：**
- Presigned URL 在 `expiresIn` 秒内有效
- 单个分片上传失败只需重试该分片，无需重新创建会话
- 合并失败可重试（幂等）
- 上传中断可用 `GET /buckets/:id/uploads/:uploadId/parts` 查询已完成的分片，只补传缺失的分片

---

## 6. 安全

- 所有 multipart API 端点需要 **admin (root/Operator/wheel)** 权限
- Presigned URL 通过 HMAC 签名，不可伪造
- OSS / R2 各自的签名方案保证 URL 只能在有效期内使用
- 分片上传的 UploadId 不暴露敏感信息
