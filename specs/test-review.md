# 测试用例审视报告

> 2026-06-24 | 63 测试文件 | 996 测试 | 1 跳过

## 覆盖缺口

### 直接单元测试覆盖率：~24%（38/160 业务逻辑文件）

| 层 | 源文件数 | 有单测 | 只有集成测试 | 完全无测试 |
|----|---------|--------|------------|----------|
| `core/` 数据结构 (dag/queue/tree/hash/circular/linked) | 10 | 10 | 0 | 0 |
| `core/store/` | 14 | 5 | 0 | **9** |
| `core/provider/` | 16 | 5 | 0 | **11** |
| `core/auth/` | 5 | 3 | 0 | **2** |
| `core/audit/` | 8 | 1 | 0 | **7** |
| `core/events/` | 3 | 3 | 0 | 0 |
| `core/middleware/` | 6 | 2 | 0 | **4** |
| `core/scheduler/` | 10 | 2 (性质测试) | 0 | **8** |
| `providers/` (所有云实现) | 24 | 0 | 0 | **24** |
| `features/` (handler+service) | 50 | 3 | 15 | **32** |
| `queue/` | 4 | 1 | 0 | **3** |

### 完全无测试的关键模块

| 优先级 | 模块 | 风险 |
|--------|------|------|
| **P0** | `providers/alibaba/eci-container.ts` | ECI 创建/删除/描述 — 核心业务流程无测试 |
| **P0** | `features/actions/runner.ts` (77 RFC) | WorkflowRunner — 最复杂的调度逻辑无测试 |
| **P0** | `features/permission/perm-checker.ts` | 权限评估 — 每次请求调用，无直接测试 |
| **P1** | `features/sandbox/sandbox.service.ts` (72 RFC) | 沙箱状态机 — 只有集成测试 |
| **P1** | `features/permission/group-manager.ts` | 用户组/权限组 — 无测试 |
| **P1** | `features/permission/route-acl-manager.ts` | 路由 ACL — 缓存逻辑无测试 |
| **P1** | `core/store/adapters/cloudflare-kv.ts` | CF KV 适配器 — 生产路径无测试 |
| **P1** | `core/store/adapters/d1.ts` | D1 适配器 — 生产路径无测试 |
| **P2** | `queue/cf-queue.ts` | CF Queue 生产适配器无测试 |
| **P2** | `core/scheduler/dag/dag-scheduler.ts` | DAG 调度器 — 只在性质测试中通过 |

---

## 测试质量

### HIGH — 占位测试（空断言）

| 文件:行 | 问题 |
|---------|------|
| `tests/features/sandbox/logs-integration.test.ts:15` | `expect(true).toBe(true)` + 注释 "需要 mock SandboxService" |
| `tests/features/sandbox/logs-integration.test.ts:70-85` | 整个 "沙箱 Start API" describe 块断言模拟函数而非真实行为 |

### MED — 时序依赖（可能不稳定）

| 文件 | setTimeout 数量 | 建议 |
|------|----------------|------|
| `tests/core/events/image-pull.test.ts` | 3 × 20ms | 用 FakeTimerBackend tick() |
| `tests/core/events/health-check.test.ts` | 2 × 10ms | 同上 |
| `tests/core/events/health-check-decision-table.test.ts` | 2 × 10ms | 同上 |
| `tests/core/event-bus/loop.test.ts` | 3 × 1-10ms | 用 vi.advanceTimersByTime |
| `tests/core/store/adapters/cached.test.ts` | 1 × 20ms | TTL 等待 |
| `tests/core/middleware/rate-limit.test.ts` | 1 × 5ms | 速率窗口等待 |
| `tests/core/store/occ-linearizability.test.ts` | 9 × 多值 | 压力测试延迟 |

**统一修复**：用 `vi.useFakeTimers()` + `FakeTimerBackend` 消除所有 `setTimeout`。`EventBus`、`EventLoop`、`FakeTimerBackend` 已支持确定性时钟。

### MED — 全局可变状态

| 文件:行 | 问题 |
|---------|------|
| `tests/core/provider/resolution.test.ts:105-119` | 直接修改 `process.env['ALIBABA_ACCESS_KEY_ID']`，测试间可能泄漏 |
| **22 文件** | 163+ 处 `as any` 绕过类型检查 |

**建议**：用 `vi.stubEnv()` 替代直接 `process.env` 赋值（vitest 自动恢复）。

### MED — 命名与实际内容不匹配

| 文件:行 | 问题 |
|---------|------|
| `tests/RESTfulApi/authz-e2e.test.ts:154` | describe "Forbidden (403)" 下唯一的子测试断言 200 |
| `tests/features/sandbox/logs-integration.test.ts:10` | describe "沙箱日志 API" 没有任何 API 调用 |

### MED — 薄弱断言

| 文件:行 | 问题 |
|---------|------|
| `tests/RESTfulApi/auth.test.ts:151-158` | "register and list" 只检查 200，不检查列表内容 |
| `tests/core/events/health-check.test.ts:76` | "GCs Stopped sandbox" — `expect(true).toBe(true)`，无结果断言 |
| `tests/core/events/health-check.test.ts:233` | "re-enqueues" — 同上 |

### LOW — 其他

| 项目 | 问题 |
|------|------|
| 跳过的测试 | `occ-linearizability.test.ts:1105` — `it.skip('5k concurrent workloads')`，注释 "60-120 秒不适合 CI"。可接受 |
| 硬编码测试密钥 | 8 处使用 `secret123` / `admin` / `ak_test` 等。仅限测试夹具，无真实泄露风险 |
| 孤立 HTTP 服务器 | RESTfulApi 测试使用真实 HTTP 服务器 + 随机端口，`afterAll` 失败可能泄漏进程 |
| Stub 耦合 | `tests/core/provider/abstraction.test.ts` 直接 import `src/providers/stub/container.ts`，绕过提供者抽象 |

---

## 测试亮点

| 项目 | 说明 |
|------|------|
| 性质测试 (fast-check) | `occ-linearizability.test.ts`、`toposort-properties.test.ts`、`scheduler-properties.test.ts`、`policy-properties.test.ts`、`encryption-properties.test.ts` — 随机测试覆盖 |
| 决策表测试 | `health-check-decision-table.test.ts` — 16 行覆盖 14 个 GC 路径 + 2 个边界，表驱动，易维护 |
| 0 个 `test.only` | 无遗留调试代码 |
| 模块化 setup | `RESTfulApi/helper.ts` 提供一致的 `startTestServer()` / `stopTestServer()` |
| 错误路径覆盖 | `errors.test.ts`、`resolution.test.ts`、`durable-object.test.ts`、`rate-limit.test.ts` 系统性测试异常 |

---

## 建议优先级

| 优先级 | 操作 | 预估工作量 |
|--------|------|-----------|
| **P0** | 消除 5 个占位 `expect(true).toBe(true)` | 30min |
| **P0** | `perm-checker.test.ts` — 权限评估单元测试 | 1h |
| **P1** | `route-acl-manager.test.ts` — 缓存+版本号逻辑 | 30min |
| **P1** | 用 `vi.useFakeTimers()` 替换所有 `setTimeout` 时序依赖 | 2h |
| **P1** | `sandbox.service.test.ts` — 沙箱状态机单元测试 | 2h |
| **P2** | `runner.test.ts` — WorkflowRunner 核心路径 | 3h |
| **P2** | `eci-container.test.ts` — ECI 创建/删除 mock 测试 | 2h |
| **P2** | 用 `vi.stubEnv()` 替换直接 `process.env` 操作 (2 处) | 5min |
