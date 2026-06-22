# Cloudflare Queues — 迁移日志

> 日期: 2026-06-09
> 目标: 从纯进程内 EventLoop 升级为 EventLoop + Cloudflare Queues 混合架构
> 原则: 向后兼容，Queue 不可用时自动回退 EventLoop

## 变更清单

### 新增文件

| 文件 | 作用 |
|------|------|
| `src/queue/types.ts` | 任务消息联合类型 `TaskMessage`，含 3 种子类型 |
| `src/queue/producer.ts` | `Queue producer` 类 — 封装 `Queue.send()`/`sendBatch()` |
| `src/queue/consumer.ts` | `processTaskBatch()` — Queue consumer 处理器 |
| `src/queue/index.ts` | Barrel re-export |

### 修改文件

| 文件 | 变更 |
|------|------|
| `wrangler.toml` | 新增 `[[queues.producers]]` + `[[queues.consumers]]`，修复 AlarmTimerDO 缺失的 migration v2 |
| `src/index.ts` | 新增 `queue()` export handler，导入 `TaskMessage` 类型 |
| `src/core/app.ts` | 创建 `Queue producer`，注入 `AppContext`/`FeatureDeps`/`AppInstance`，健康检查 4 个 GC 路径 + image.pull 均改为 Queue-first 策略 |
| `.env` | 无需变更（Queue 由 platform bindings 注入，不通过 env） |

---

## 架构变更

### Before: 纯 EventLoop

```
┌──────────────────────────────────────────────────────┐
│                   EventLoop tick                     │
│  health:check ─> inline GC (provider.delete + OCC)   │
│  image:pull   ─> inline pull (fetch + wait)          │
│  bucket-key   ─> inline rotation                     │
│  instance     ─> inline heartbeat timeout             │
└──────────────────────────────────────────────────────┘
  问题: 所有工作共享 30ms CPU budget，GC 阻塞 tick
```

### After: EventLoop + Queues（tick 只扫描不突变）

```
┌─────────────────────┐     ┌──────────────────────────┐
│   EventLoop tick    │     │  Queue Consumer          │
│  (纯扫描, 不入队)    │     │  (independent budget)    │
│                     │     │                          │
│  sandbox:ids ──>    │ send│  image.pull ─> fetch     │
│    status scan      │ ──> │  sandbox.gc ─> delete    │
│    → enqueue GC     │     │  bucket-key ─> rotate    │
│                     │     │                          │
│  instance:ids ──>   │     │  own CPU budget          │
│    heartbeat scan   │     │  auto-retry on failure   │
│    (inline, 轻量)    │     │                          │
│                     │     │                          │
│  bucket-key:ids ──> │     │                          │
│    expiry scan      │     │                          │
│    → enqueue rotate │     │                          │
│                     │     │                          │
│  如果 Queue 不可用   │     │                          │
│  → 回退 inline 执行  │     └──────────────────────────┘
└─────────────────────┘
```

### 决策树

```
GcTask / ImagePull
├─ queueProducer.available?
│  ├─ true  → queueProducer.send(task)
│  │          └─ Queue consumer: 独立 CPU budget 执行
│  └─ false → 回退 inline 执行（现有逻辑不变）
```

---

## 任务类型

| 类型 | Payload | 触发位置 | Consumer 处理 |
|------|---------|---------|--------------|
| `sandbox:gc` | `SandboxGcPayload` | 健康检查 4 条 GC 路径 | `provider.delete` → OCC 状态更新 → audit |
| `image:pull` | `ImagePullPayload` | `eventBus 'image:pull'` | resolve provider → resolve creds → `pull()` → 更新 task 状态 |
| `sandbox:provision` | `SandboxProvisionPayload` | 预留，尚未接入 | 未来: bucket key 绑定、DNS 注册等异步步骤 |
| `bucket-key:rotate` | `BucketKeyRotatePayload` | 健康检查 tick → 扫描 bucket-key:ids，到期则入队 | `crypto.getRandomValues` 生成新 SK → OCC 写回 |

---

## 开发环境

### wrangler dev（推荐）

```bash
npm run dev:worker
```

Miniflare 自动启动本地 Queue。`Queue producer` 检测到 `TASK_QUEUE` binding 后自动启用，Queue consumer 随 Worker 一起运行。

**验证 Queue 可用**:

```
# 启动后检查日志:
[app] Queue producer enabled (TASK_QUEUE)    ← Queue 在线
[app] Queue producer unavailable — falling back to EventLoop  ← Queue 不可用，已回退
```

**手动触发 tick + GC 来测试**:

```bash
curl -X POST http://localhost:3000/__tick
```

### tsx dev（Node.js）

```bash
npm run dev
```

不使用 wrangler，无 TASK_QUEUE binding。`Queue producer.available === false`，所有任务走现有 EventLoop 路径。行为不变。

---

## 生产部署

### 1. 创建 Queue（一次性）

```bash
npx wrangler queues create hbi-aad-tasks
```

### 2. 部署 Worker

```bash
npm run deploy
```

wrangler.toml 中的 queue bindings 自动生效。

### 3. 验证

```bash
# 查看队列状态
npx wrangler queues list

# 在 Cloudflare Dashboard → Queues 查看消息积压和消费速率
```

---

## 回退方案

如果 Queue 出现问题（消息积压、消费异常），回退步骤：

1. 注释 `wrangler.toml` 中的 `[[queues.producers]]` 和 `[[queues.consumers]]` 段
2. 重新部署: `npm run deploy`
3. `Queue producer.available === false` → 所有任务自动回退 inline 执行

无需修改任何业务代码。

---

## 待评估

生产运行后关注以下指标：

- **GC 延迟**: 从检测到 unhealthy 到实际清理的时间差（Queue 模式预计 +1-5s）
- **image.pull 超时**: Queue consumer 独立 CPU budget 是否改善了 pull 成功率
- **bucket-key 轮换延迟**: 密钥到期到实际轮换的时间差（Queue 模式 +1-5s，跟 GC 相同）
- **消息积压**: `hbi-aad-tasks` 的 depth 指标，正常应保持在个位数
- **重试次数**: Queue 自动重试的成功率，是否需要调整 `max_retries`
- **tick CPU 时间**: 迁移前后 tick 的 CPU time 对比（预期显著下降，因为 tick 只扫描不入队）

---

## 已知限制

1. **Queue consumer 无 secretEncryption**: consumer 通过 `getApp()` 获取 app instance，但 `secretEncryption` 不在 `AppInstance` 上。`image:pull` consumer handler 的 credential 解析目前用 `(stores as any).secretEncryption`，需要后续将 `secretEncryption` 加入 `AppInstance`。
2. **Queue 不支持定时投递**: 延迟投递需要自己用 DO alarm 实现，暂不需要。
3. **消息大小上限 128KB**: `SandboxGcPayload` 远小于此限制，`ImagePullPayload` 也安全。
4. **本地 Queue 不持久化**: Miniflare 的 Queue 是内存实现，重启丢失。仅影响本地开发体验，不影响生产。
