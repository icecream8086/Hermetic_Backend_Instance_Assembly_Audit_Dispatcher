# 后端组件引入路线图

> 对标 Cloudflare Workers 生态，避免重复造轮子。

## 现状覆盖

| 层次 | 组件 | 状态 | 实现 |
|------|------|------|------|
| 接入层 | 反向代理/网关 | ✅ | Hono + secureHeaders + CORS + bodyLimit |
| 接入层 | 负载均衡 | ✅ | Cloudflare 网络层自带 |
| 接入层 | CDN | ❌ | 有前端，需托管方案 |
| 应用服务层 | Web 框架 | ✅ | Hono 4.x，12 feature 切片 |
| 应用服务层 | 定时任务 | ✅ | EventLoop + ITimerBackend（setInterval / DO Alarm / manual） |
| 应用服务层 | 消息队列 | ⚠️ | 进程内 EventBus + CircularQueue，无外部 MQ |
| 应用服务层 | 服务发现/配置 | ✅ | Workers Bindings + loadConfig() |
| 基础设施层 | 容器运行时 | ✅ | IContainerProvider（Podman / Alibaba ECI / Stub） |
| 基础设施层 | 计算平台 | ✅ | Cloudflare Workers + Durable Objects |
| 存储层 | 键值/缓存 | ✅ | CachedAtomicStore + RequestCachedAtomicStore + BloomFilter |
| 存储层 | 关系型数据库 | ⚠️ | D1 已接线，零查询使用 |
| 存储层 | 对象存储 | ✅ | R2 (avatar) + S3 provider (buckets) |
| 存储层 | 搜索引擎 | ❌ | 审计日志用子串匹配，暂不需要 |
| 可观测性 | 日志 | ✅ | 多后端：Workers / KV / Local / Noop + dmesg 格式 |
| 可观测性 | 监控/追踪 | ⚠️ | 仅 AtomicStoreMetrics + Server-Timing header |

额外已实现：权限 RBAC + DAG、审计 kern-level 0-7、AES-256-GCM 加密、健康检查 6 路径 GC、WebSocket 通知/日志流、DAG 拓扑编排、S3 策略引擎。

---

## 推荐引入

### 1. 邮件发送 — 邮箱验证 🔴

**现状**: 用户注册有时序 nonce 验证和登录限流，但没有邮箱归属验证。`email` 字段存在但未验证即可使用。

**方案: Resend**

```bash
npm install resend  # 或者直接用 fetch，不需要 SDK
```

```
注册流程:
  POST /api/users/register → 生成验证 nonce → Resend 发邮件 → 用户点链接
  GET /api/users/verify?code={nonce} → 标记 email_verified = true

nonce 复用现有 checkNonce() 基础设施（src/features/users/service.ts:110）
```

```typescript
// Resend 在 Worker 里就是一次 fetch，I/O 不占 CPU
// POST https://api.resend.com/emails
// Authorization: Bearer re_xxx
```

**为什么是 Resend 不是其他**:
- SendGrid SDK 太重，Mailgun API 不够简洁
- Resend 为 serverless 优化，原生 fetch 即可，自带 Dashboard
- Workers 免费版 10ms CPU 限制不影响——fetch 到外部是 I/O

**接入位置**: `src/features/users/` 新增 email-verification 逻辑，nonce 基础设施已存在。

---

### 2. 前端静态资源托管 🔴

**方案 A — Cloudflare Pages（独立 SPA 推荐）**

前端独立仓库、独立部署、独立 CI/CD：

```
app.yourdomain.com  → Worker（API）
yourdomain.com      → Pages（前端 SPA）
```

- 连接 GitHub 仓库，推送自动构建部署
- Workers 代码完全不感知静态文件
- 跨域通过 CORS 配置解决

**方案 B — Workers Assets（轻量面板）**

前端产出一组静态文件，跟后端放同一个仓库：

```toml
# wrangler.toml
[assets]
directory = "./frontend/dist"
binding = "ASSETS"
```

- 静态文件由边缘网络提供，不占 Worker 请求配额
- 适合随 API 一起迭代的轻量管理面板

**决策依据**: 前端是独立团队做的 SPA → Pages；是跟着后端一起改的管理面板 → Assets。

---

### 3. API Key / Service Account 🟡

**现状**: 只有 Bearer Token（用户登录），无 API Key。CI/CD 或外部服务调用需模拟用户登录。

```typescript
// src/features/api-keys/ 新增
interface ApiKey {
  id: string;
  name: string;
  keyHash: string;       // SHA-256(key) via Web Crypto
  prefix: string;        // "hbiaa_xxxxxxxx" 前 8 位明文
  permissionGroupId: string;  // 绑定到现有权限组
  createdBy: string;
  expiresAt?: number;
}
```

**认证流程**:

```
客户端: Authorization: Bearer hbiaa_xxxxxxxxxxxx
中间件: 检测前缀 hbiaa_ → 哈希 → 查 api-key:{hash} → 走 API Key 权限
       检测前缀 session: → 走现有 Token 验证
```

**可托管**: [Unkey.dev](https://unkey.dev) 提供托管 API Key 管理，自带速率限制、用量统计、webhook。不想维护 key CRUD 生命周期代码可以直接用。

---

### 4. 消息队列 🟡

**现状**: 进程内 EventBus + EventLoop，`image.pull` 是唯一持久化事件。沙箱创建、GC 回收都在 tick 内联执行。

**何时引入**: 健康检查 tick 同时处理 GC + 镜像拉取 + 密钥轮换 + 心跳超时时，30ms CPU 可能不足。

```toml
# wrangler.toml
[[queues.producers]]
binding = "TASK_QUEUE"
queue = "hbi-aad-tasks"

[[queues.consumers]]
queue = "hbi-aad-tasks"
max_batch_size = 5
max_batch_timeout = 10
```

```typescript
export default {
  async queue(batch: MessageBatch<SandboxTask>, env: Env) {
    for (const msg of batch.messages) {
      switch (msg.body.type) {
        case 'sandbox.provision': await provisionSandbox(msg.body); break;
        case 'sandbox.gc':        await gcSandbox(msg.body); break;
        case 'image.pull':        await pullImage(msg.body); break;
      }
    }
  },
};
```

**适合入队的场景**:

| 任务 | 原因 |
|------|------|
| 沙箱 provision | 涉及多次 provider API 调用，耗时不定 |
| Stopped-sandbox GC | 目前内联，大量沙箱时可能超 CPU |
| 镜像拉取 | 已持久化，Queue consumer 比 EventLoop 更天然 |
| 审计日志批量刷 | 高吞吐时聚合写减少 I/O |

**不适合**: 实时请求-响应（创建沙箱仍需同步返回 providerId）、WebSocket 推送（NotificationDO 已做）。

**不需要引入外部队列库**（Bull/Agenda/BullMQ 依赖 Redis，Workers 无 Redis）。

---

### 5. 分布式锁 — DO 原生支持 🟢

**现状**: 首次注册用 atomic flag，健康检查 GC 有 OCC 重试。无显式锁。

Cloudflare 生态里 Durable Object 的单实例天然就是锁，不需要 Redis/etcd。

```
POST /lock/{key}        → 获取锁，返回 lease token
DELETE /lock/{key}?token=xxx → 释放锁
```

**适用场景**:
- 防止同一个 ComputeInstance 上并发创建过多容器
- 防止 bucket key 并发轮换

**为什么不需要 Redis Redlock**: DO 的 single-threaded execution guarantee 已经提供互斥语义，额外引入 Redis 只会增加运维成本和故障点。

---

### 6. 监控/分析 🟢

**现状**: 只有 `AtomicStoreMetrics`（cache hit/miss）和 `Server-Timing` header。

**Workers Analytics Engine** 无需额外 infrastructure：

```typescript
// 在健康检查、沙箱创建、API 请求中打点
env.ANALYTICS.writeDataPoint({
  blobs: [sandboxId, region, action],
  doubles: [durationMs, containerCount],
  indexes: ['sandbox.provision'],
});
```

在 Cloudflare Dashboard → Analytics 直接可视化，零运维。

---

## 不要碰的组件

| 组件 | 原因 |
|------|------|
| **自建消息队列** | Cloudflare Queues 已覆盖，不要造 Kafka-lite |
| **Redis/etcd** | DO + KV 已覆盖缓存/锁/协调，不要引入外部依赖 |
| **自建搜索引擎** | Elasticsearch/Meilisearch 运维成本高，审计日志量还没到这个量级。日后需要时用 D1 FTS5 |
| **GraphQL 层** | Hono REST 路由足够清晰，GraphQL 解析会加 CPU 开销 |
| **gRPC** | Workers 不支持 HTTP/2 server push |
| **自建 CDN** | Cloudflare 自带全球 CDN |
| **容器镜像 Registry** | Docker Hub / ACR / GHCR 已有，不自建 |
| **自建 PKI/CA** | 证书交给 Cloudflare SSL for SaaS 或 Let's Encrypt |
| **定时任务框架** | EventLoop + DO Alarm 已覆盖，Bull/Agenda 依赖 Redis |
| **自建邮件服务器** | SMTP 协议在 Worker 上不现实，Resend 已是标准方案 |
| **D1 + Drizzle ORM** | 暂缓，后期给权限系统用 |

---

## 不引入 npm 包也可以实现的

以下功能用现有基础设施（Hono + DO + KV + Web Crypto API）即可构建，不需要新增依赖：

- **API Key 管理**: Web Crypto `crypto.subtle.digest('SHA-256', ...)` + DO 存储
- **分布式锁**: DO 单实例语义 = 天然互斥
- **邮箱验证 nonce**: 现有 `checkNonce()` + Resend fetch
- **Feature Flags**: KV key `_sys:feature:*` + `config.features: Record<string, boolean>`
- **分布式限流**: DO 做滑动窗口计数器，替代当前内存 Map

---

## 总结

| 优先级 | 组件 | 新增依赖 | 工作量 |
|------|------|------|------|
| 🔴 高 | 邮件验证 (Resend) | resend 或 fetch | 半天 |
| 🔴 高 | 前端部署 (Pages/Assets) | 无 | 取决于前端规模 |
| 🟡 中 | API Key | 无（或 Unkey.dev） | 1 天 |
| 🟡 中 | Cloudflare Queues | 无 | 1 天 |
| 🟢 低 | 分布式锁 (DO) | 无 | 半天 |
| 🟢 低 | Analytics Engine | 无 | 半天 |
