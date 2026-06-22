# 单元测试评审报告

> 日期: 2026-06-09
> 现状: 42 test files, 735 tests, 48% statement coverage, 52% line coverage
> 已知: Alibaba/Cloudflare provider 需要真实云凭证，不可单元测

## 一、总体评估

### 已良好覆盖 (≥70%)

| 模块 | 覆盖率 | 评价 |
|------|--------|------|
| `core/dag` (graph + orchestrator) | 100% | 拓扑排序 + 批量编排全覆盖 |
| `core/tree` (binary-tree + tree) | 97% | 边界值 + 结构 invariants |
| `core/linked-list` | 100% | — |
| `core/hash-table` | 100% | — |
| `core/network` (cidr + pool) | 83% | CIDR 解析 + 子网池分配/回收 |
| `core/logger/console-logger` | 100% | — |
| `core/store/adapters/durable-object` | 高 | 31 tests: get/set/transact/OCC/error/boundary/alarm |
| `core/store/adapters/file-kv` | 高 | 12 tests: get/set/OCC/key sanitisation |
| `core/store/adapters/cached` | 有 | Bloom filter + 缓存层 |
| `core/store/adapters/file-query` | 有 | SQL 解析 |
| `core/store/adapters/file-blob` | 有 | blob 读写 |
| `core/event-bus/bus + loop` | 有 | pub/sub + tick/lifecycle |
| `core/circular-queue` | 有 | 环形队列 |
| `core/provider/abstraction` | 有 | 接口 contract + type shape |
| `core/s3-policy/manager` | 有 | 15 tests: CRUD + resolve |
| `features/permission` | 69% | 4 manager 分拆后覆盖尚可 |
| `features/sandbox/assembly/pod-resolver` | 92% | — |
| `features/sandbox/log-stream-do` | 有 | WebSocket + alarm |
| `features/template/applicator` | 70% | — |
| `RESTfulApi/*` | E2E | 11 文件: auth/users/perm/acl/log-policy/template/system-group/compare |

### 已存在但有缺陷

| 模块 | 问题 |
|------|------|
| `features/sandbox/sandbox.service.ts` | 5.9% coverage — provision/terminate/stop/start/health/sync 全部未测 |
| `features/topology/handler.ts` | 15% — 30+ 路由，几乎全未测 |
| `queue/producer.ts` | 8.6% — constructor 测了，send/sendBatch/sendXxx 全未测 |
| `core/provider/abstraction.test.ts` | 类型验证为主，缺少 provider 行为测试 |
| `core/provider/security.test.ts` | probe sanitization 有，但 secureContainerProvider 只是签名检查，未测实际代理行为 |
| `RESTfulApi/authz-e2e.test.ts` | 只测 wheel 用户和 deny override，缺 root/normal 角色路径 |

---

## 二、优先级分级

### 🔴 P0 — 核心路径零覆盖（安全/可靠性风险）

| 目标文件 | 行数 | 风险 | 建议测试数 |
|---------|------|------|-----------|
| `core/events/health-check.ts` | 163 | **健康检查全逻辑** — 6 条 GC 路径、instance 心跳、bucket-key 轮换 | 10 |
| `core/events/image-pull.ts` | 70 | 镜像拉取全逻辑 | 4 |
| `queue/producer.ts` | 78 | send/sendBatch/sendXxx 方法 | 6 |
| `queue/consumer.ts` | 196 | processTaskBatch + 4 个 handler | 8 |
| `core/auth/credential.ts` | 268 | 凭证加密存储 CRUD — 安全敏感 | 10 |
| `core/auth/secret-encryption.ts` | 60 | AES-GCM 加解密 — 安全敏感 | 5 |
| `core/middleware/auth.ts` | 145 | 每个 API 请求都经过此中间件 | 8 |
| `core/middleware/rate-limit.ts` | 40 | 限流逻辑 | 3 |
| `core/audit/kv-audit-logger.ts` | 90 | KV 审计日志写入/查询 | 5 |

**P0 合计**: ~58 个测试

### 🟡 P1 — 高价值业务逻辑

| 目标文件 | 行数 | 当前覆盖率 | 建议测试数 |
|---------|------|-----------|-----------|
| `features/sandbox/sandbox.service.ts` | 700 | 5.9% | 15 |
| `features/topology/handler.ts` | 390 | 15% | 12 |
| `features/container-secret/service.ts` | 185 | 4.7% | 6 |
| `features/volume/service.ts` | 164 | 4.4% | 6 |
| `features/network/service.ts` | 140 | 11.9% | 5 |
| `features/subnet/service.ts` | 115 | 11.8% | 5 |
| `core/app.ts` | 360 | 低 | 5 (createApp with stub config) |
| `core/audit/local-audit-logger.ts` | 65 | 0% | 3 |
| `core/middleware/idempotency.ts` | 60 | 0% | 3 |
| `core/region/instance.ts` | 230 | 低 | 8 |
| `core/region/bucket.ts` | 183 | 低 | 8 |

**P1 合计**: ~76 个测试

### 🟢 P2 — Provider 实现

| 目标文件 | 备注 |
|---------|------|
| `providers/podman/podman-provider.ts` | 已有 podman-nginx.test.ts 集成测试 (docker.io/nginx) |
| `providers/podman/podman-group-provider.ts` | 0% — 需要 Podman pod 环境 |
| `providers/stub/container.ts` | 41% — 可纯内存测完整生命周期 |
| `providers/stub/image.ts` | 3.2% — 轻量，可全测 |
| `providers/s3/aws-s3.ts` | 20% — 需要 SigV4 签名验证，可测 request signing |
| `providers/alibaba/*` | 0% — **不可单元测**，需要真实 AK/SK + ECI 实例 |
| `providers/cloudflare/*` | 2.8% — **不可单元测**，需要 CF API Token |

### ⚪ P3 — 无需测试

以下文件类型不需要独立测试文件：

- **纯类型定义** (`types.ts`, `interfaces.ts`, `brand.ts`)
- **Barrel re-export** (`index.ts`, `generated.ts`)
- **空实现/占位** (`noop-audit-logger.ts`, `manual-backend.ts`)
- **配置加载** (`config/env.ts`, `config/types.ts`) — 值在集成测试中覆盖

---

## 三、已存在测试的质量缺陷

### 1. `core/provider/abstraction.test.ts`

- ✅ 接口 contract 验证（IContainerProvider/IS3Provider/IContainerGroupProvider）
- ✅ 类型 shape 验证（CreateContainerGroupInput/ContainerGroupRuntime/SecretMountConfig）
- ❌ `StubContainerProvider` baseline 只测了 create→describe→delete，缺失：stop/start/restart/kill/pause/unpause/exec/getLogs/getStatus/stats/top
- ❌ 未测 S3 provider dispatch 的 minio 路径（只测了 aws-s3 和 alibaba-oss）
- ❌ `createProviderRegistry` 测试只在内存创建了 registry，未验证 resolveContainer/resolveImage 行为

### 2. `core/s3-policy/manager.test.ts`

- ✅ CRUD 基本操作
- ✅ resolve() 合并逻辑
- ✅ toMinioPolicy / toOssPolicy 翻译
- ❌ 缺 deny-override 优先级验证（deny + allow 冲突时 deny 应优先）
- ❌ 缺多条 policy merge 后的顺序验证

### 3. `core/event-bus/loop.test.ts`

- ✅ 生命周期（start/stop/pause/resume/configure）
- ❌ 缺 persistEnqueue + recover 路径（store recovery 逻辑）
- ❌ 缺 maxQueueSize 溢出行为

### 4. `core/event-bus/bus.test.ts`

- ❌ 缺多 handler 并发异常隔离验证
- ❌ 缺 onError callback 验证

### 5. `RESTfulApi/authz-e2e.test.ts`

- ❌ 只测 wheel 用户和 deny override
- ❌ 缺 root 角色的路由访问
- ❌ 缺 normal 用户的权限边界（应该被拒的操作）
- ❌ 缺 sudo 提权 + 超时回退

### 6. 健康检查 — 零测试

- ❌ 6 条 GC 路径（stopped-gc/provider-gone/exited-gc/unhealthy-gc/manual/whitelist）全部未测
- ❌ Instance 心跳超时逻辑未测
- ❌ Bucket key 轮换逻辑未测
- ❌ OCC 重试 3 次逻辑未测

---

## 四、量化汇总

| 级别 | 新增测试数 | 新增文件数 | 关键文件 |
|------|-----------|-----------|---------|
| P0 | ~58 | 9 | health-check, image-pull, queue, credential, secret-encryption, authz middleware, rate-limit, audit |
| P1 | ~76 | 11 | sandbox.service, topology handler, container-secret service, volume service, network service, subnet service, app.ts, local-audit, instance, bucket |
| P2 | ~20 | 4 | stub container/image, podman-group, aws-s3 signing |
| **合计** | **~154** | **24** | — |

当前 735 tests → 补齐后预计 ~890 tests，覆盖率 48% → 预计 65-70%。

---

## 五、建议执行顺序

1. **`core/auth/secret-encryption.test.ts`** (5 tests) — 独立、无依赖、安全关键
2. **`core/auth/credential.test.ts`** (10 tests) — 依赖 secretEncryption，安全关键
3. **`core/events/health-check.test.ts`** (10 tests) — 6 条 GC 路径，覆盖面大
4. **`queue/producer.test.ts` + `queue/consumer.test.ts`** (14 tests) — 新代码，正需要回归保护
5. **`core/middleware/auth.test.ts`** (8 tests) — 每个请求都经过
6. **`features/sandbox/sandbox.service.test.ts`** (15 tests) — 最大单体服务
7. **P1 feature services** — 按复杂度顺序逐个补
