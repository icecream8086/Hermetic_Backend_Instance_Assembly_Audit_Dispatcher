# 重构计划 TODO

> 参考模型: RHEL 权限体系 · dmesg/journald · Airflow · GitHub Actions · K8s Pod · iptables · systemd · SELinux
> 已完成的以 ✅ 标记

---

## 0. 基础设施重构 (Phase 0-6)

### Phase 0a: 删 LogLevel, 统一 KernLevel ✅

- [x] `core/types.ts` — 删 `LogLevel` enum
- [x] `core/logger/types.ts` — `LogInput`/`LogEntry` 改用 `KernLevel`
- [x] `core/logger/log-policy.ts` — 删 `kernToName()` 桥接, 直接用 `KernLevel`
- [x] 12 个 feature service — `LogLevel.INFO` → `KernLevel.INFO` 全替换
- [x] `features/permission/handler.ts` — zod schema 更新

### Phase 0: 合并 audit + logger ✅

- [x] `core/logger/types.ts` `interfaces.ts` — 已删除
- [x] `core/logger/` 文件移入 `core/audit/` (console-logger, log-policy, formatter, tail-coordinator, storage-adapters)
- [x] `core/audit/types.ts` — 吸收 `LogInput`/`LogEntry`/`LogQuery`/`StorageEntry`, 统一为 `AuditEntry`/`StoredAuditEntry`
- [x] `core/audit/types.ts` — 新增 `IAuditLogger`, `IAuditAdmin`, `IAuditWriter.writeSync()`
- [x] `core/audit/` 所有 logger — 实现统一 `IAuditWriter` + `IAuditReader` 接口
- [x] `core/logger/index.ts` — 保留为 `@deprecated` 重导出兼容层
- [x] 26 个文件 import 路径更新

### Phase 0b: Capability 位域 (合入 Phase 4) ✅

- [x] `core/permission/types.ts` — `Capability` 19 个能力位 + `actionToCapability()` + `hasCapability()`

### Phase 1: Facility 数字化 + Priority 编码 ✅

- [x] `core/audit/kern-level.ts` — `AuditFacility` const enum (0-23) + `encodePriority`/`decodePriority`/`resolveFacility`
- [x] `core/audit/types.ts` — `AuditEntry`/`StoredAuditEntry`/`LogQuery` 新增 `priority` 字段
- [x] 5 个 logger 实现 — `write()` 自动计算 priority = facility × 8 + level

### Phase 2: 日志字段可信分离 ✅

- [x] `core/audit/types.ts` — `TrustedFields` 接口 (`_request_id`, `_user_id`, `_source_ip`, `_boot_id`, `_sandbox_id`)
- [x] `core/audit/context.ts` — `trustedFromRequest()` + `createAuditEntry()` + `setBootId()`
- [x] `core/app.ts` — 启动时 `setBootId(crypto.randomUUID())`

### Phase 3: 游标实现 ✅

- [x] `core/audit/types.ts` — `LogCursor` 6 元组 + `LogQueryResult` + `encodeCursor`/`decodeCursor`/`cursorFromEntry`
- [x] 6 个 logger — `query()` 返回 `LogQueryResult { entries, nextCursor, total }`
- [x] `core/audit/audit-router.ts` — GET `/logs` 支持 `afterCursor` 参数

### Phase 4: 权限三层门控 ✅

- [x] `core/permission/types.ts` — `DenialLayer` enum + `DENIAL_AUDIT_TYPE` + `Capability` 位域
- [x] `core/permission/types.ts` — `PermissionResult` 新增 `layer?` `auditType?`
- [x] `features/permission/perm-checker.ts` — `#checkDac()` + `#checkCap()` + `#checkMac()` + `checkAll()`
- [x] `features/permission/types.ts` — `PolicyMatchResult` 新增 `layer?` `auditType?`

### Phase 5: 中间件注册表 ✅

- [x] `core/middleware/registry.ts` — `MiddlewareTable` × `MiddlewareChain` + `registerMiddleware()` + `installMiddleware()`

### Phase 6: MESSAGE_ID + 速率限制双参数 ✅

- [x] `core/audit/message-ids.ts` — MESSAGE_ID UUID 常量 (sandbox/auth/perm/provider)
- [x] `core/middleware/rate-limit.ts` — Token Bucket (burst + intervalMs) 替代滑动窗口
- [x] `config/types.ts` + `app.ts` — `burst`/`intervalMs` 配置项

---

## 1. 容器实例抽象

### 1.1 Sandbox 状态机升级 ✅
- [x] `features/sandbox/types.ts` — SandboxStatus 从 7 态扩展到 11 态 (对齐 ECI)
- [x] `features/sandbox/types.ts` — `VALID_TRANSITIONS` 完整 18 规则 ECI 转移矩阵
- [x] `features/sandbox/types.ts` — `TERMINAL_STATES` / `DELETABLE_STATES` / `isTerminal()`
- [x] `features/sandbox/types.ts` — `ContainerStatus` enum + `ContainerState` exitCode/reason/signal
- [x] `core/provider/container-lifecycle.ts` — `toSandboxStatus` / `fromSandboxStatus` 更新
- [x] `core/events/health-check.ts` — Stopped→Succeeded, Terminated→Terminating
- [x] `features/sandbox/sandbox.service.ts` — stop/start/provider mapping 更新
- [x] 全部受影响测试更新 (types, state-machine-properties, container-lifecycle, health-check-decision-table, logs-integration)

### 1.2 Container 子状态 ✅
- [x] `ContainerStatus` enum: Waiting / Running / Terminated (K8s 对齐)
- [x] `ContainerState` 新增 `finishedTime`, `exitCode`, `reason`, `signal` 字段
- [x] `runtime-mapper.ts` — `ociStatusToContainerState` 返回 `ContainerStatus`
- [ ] InitContainer + Sidecar 生命周期 (restartPolicy: Always) ⏳

### 1.3 RestartPolicy 完善 ✅
- [x] `core/scheduler/backoff.ts` — 指数退避: 10s → 20s → 40s → ... → 300s cap, 10 分钟重置
- [x] `ContainerRestartPolicy` + `RestartPolicyRule` — 每容器 exit-code-based 规则 (K8s KEP-5307)
- [x] `ContainerConfig.containerRestartPolicy` — 每容器可独立覆盖 pod 级重启策略
- [x] `tests/core/scheduler/backoff.test.ts` — 8 个测试覆盖

### 1.4 Probe 健康检查 ✅
- [x] `core/scheduler/probe-runner.ts` — kubelet 式探针评估引擎
- [x] 三种探针: livenessProbe/readinessProbe/startupProbe
- [x] 参数: failureThreshold/successThreshold/periodSeconds/timeoutSeconds/initialDelaySeconds
- [x] Handler: exec/httpGet/tcpSocket + Promise.race 超时
- [x] readinessProbe 失败 → shouldRemoveEndpoint (不重启)
- [x] startupProbe 未完成时 gating liveness/readiness
- [x] `tests/core/scheduler/probe-runner.test.ts` — 8 个测试覆盖

---

## 2. 统一 DAG 调度器 (GitHub Actions × Airflow 合并)

> 架构：`core/dag/` 提供泛型 DAG + Kahn (已有) → `core/scheduler/` 提供 Airflow 调度引擎
> → `features/actions/` 退化为 Operator 实现 + HTTP API 层，调度逻辑全部下沉到 core

### 2.1 Task 泛型类型 + TaskInstance 统一状态机 ⏳

- [ ] `core/dag/types.ts` (重写) — 统一 `Task` (operator) + `DagRun` (运行实例) + `TaskInstanceState` 合并 Airflow 13 态 + GHA 6 态
- [ ] `core/scheduler/task-instance.ts` (新) — TaskInstance 状态机:
      NONE → SCHEDULED → QUEUED → RUNNING → SUCCESS / FAILED / UP_FOR_RETRY → (回到 QUEUED)
      + SKIPPED + UPSTREAM_FAILED + DEFERRED + RESTARTING + REMOVED
      `VALID_TRANSITIONS` 映射 + `transition(from, to)`
- [ ] Task 定义: id / operatorType / config / dependsOn / triggerRule / retries / timeout
- [ ] DagRun 定义: id / dagId / status / triggeredAt / taskInstances

### 2.2 TriggerRule 引擎 ⏳

- [ ] `core/dag/trigger-rule.ts` (新) — 抄 Airflow 9 种触发规则:
      all_success / all_failed / all_done / one_success / one_failed
      / none_failed / none_skipped / none_failed_min_one_success / always
- [ ] `evaluateTriggerRule(rule, upstreamStatuses[])` 纯函数

### 2.3 主调度循环 ⏳

- [ ] `core/scheduler/dag-scheduler.ts` (新) — 抄 Airflow `SchedulerJobRunner._execute()`
      schedule → process → heartbeat → sleep 主循环
- [ ] 调度器状态: idle / running / paused
- [ ] 可插拔定时器 (复用 core/scheduler 现有抽象)

### 2.4 5 步过滤管线 + ConcurrencyMap ⏳

- [ ] `core/scheduler/filter.ts` (新) — 抄 Airflow `_executable_task_instances_to_queued()`
      1. Pool slot 检查 → starved_pools
      2. DAG 并发 (max_active_tasks) → starved_dags
      3. Task 并发 (max_active_tis_per_dag) → starved_tasks
      4. DagRun 并发 (max_active_tis_per_dagrun) → starved_task_dagruns
      5. Executor slot (parallelism)
- [ ] `core/scheduler/concurrency-map.ts` (新) — 一次查询, O(1) 并发检查
      dag_run_active_tasks_map / task_concurrency_map / task_dagrun_concurrency_map

### 2.5 Pool 信号量 ⏳

- [ ] `core/scheduler/pool.ts` (新) — 抄 Airflow Pool 模型
      name / slots / open_slots / occupied_slots

### 2.6 Backfill 引擎 ⏳

- [ ] `core/scheduler/backfill.ts` (新) — catchup 历史时间段

### 2.7 对接 features/actions — Operator 实现 + API 层 ⏳

- [ ] `features/actions/runner.ts` — 重构: 解析 WorkflowDef → Dag<Task> → 提交调度器
- [ ] Operator 注册表: `run:` → BashOperator / `uses:` → ContainerOperator / `dns:` → DnsOperator
- [ ] `features/actions/handler.ts` — API 层不变，底层执行委托给调度器
- [ ] 去掉 WorkflowRunner 内联的依赖检查(enqueueReadyJobs)，改用 TriggerRule 引擎
- [ ] Step 执行结果写回 TaskInstance 状态

---

## 3. 权限系统

### 3.1 能力位体系完善 ⏳

- [ ] `core/permission/capability.ts` — 将 capability 从 perm-checker 中独立出来
- [ ] 用户 → 能力位存储 (`user:cap:{userId}`)
- [ ] 能力位继承 (用户组 DAG 聚合能力位)
- [ ] 抄 Linux CAP_*: 至少 19 个命名能力位

### 3.2 DAC 层完善 ⏳

- [ ] 资源 owner 记录 (Sandbox.creatorId → DAC 检查)
- [ ] 资源 ACL 列表 (per-resource named user/group entries)

### 3.3 sudo 式临时提权 ⏳

- [ ] `grantTempElevation(userId, durationMs, capabilities)` — 现有只有时间限制, 需加能力位范围
- [ ] 提权审计记录 (who → what → how long)

### 3.4 路由 ACL 完善 ⏳

- [ ] wildcard method 支持
- [ ] path 前缀/精确匹配/正则 三种模式

### 3.5 权限检查集成到中间件链 ⏳

- [ ] `FILTER.INPUT` 链调用三层门控
- [ ] 每层拒绝写 audit (SYSCALL / CAPABILITIES / AVC)

---

## 4. 日志 × 审计

### 4.1 Cloudflare Workers Logs 集成 ⏳

- [ ] Logpush → R2 日志归档
- [ ] `CloudflareLogReader` — 从 R2 查询历史日志
- [ ] Logpull API 对接 (实时 tail)

### 4.2 日志轮换 ⏳

- [ ] 基于大小的驱逐 (抄 journald SystemMaxUse / SystemMaxFileSize)
- [ ] 基于时间的驱逐 (抄 journald MaxRetentionSec)
- [ ] `prune()` 实现

### 4.3 实时日志 tail ⏳

- [ ] `tail()` 实现 — WebSocket 推送
- [ ] `journalctl -f` 式跟踪

### 4.4 日志命名空间隔离 ⏳

- [ ] 按 facility 隔离日志命名空间
- [ ] per-sandbox 日志查询

---

## 5. 组件模块

### 5.1 用户/用户组模块 ⏳

- [ ] 抄 RHEL: UID/GID 数字体系 (品牌类型已有)
- [ ] 抄 RHEL: /etc/passwd 7 字段 (name:passwd:UID:GID:GECOS:directory:shell)
- [ ] 抄 RHEL: supplementary groups (辅助组列表)
- [ ] 用户能力位: `user:cap:{userId}` 存储 ability bitmask

### 5.2 密钥管理模块 ⏳

- [ ] 抄 GitHub Secret: NaCl SealedBox 公钥密封 (当前已有 AES-GCM)
- [ ] 抄 RHEL keyring: session keyring / user keyring 分层
- [ ] Org/Repo 二级可见性作用域 (all / private / selected)
- [ ] Secret 版本化 (PUT = upsert, 不保留历史)

### 5.3 计算实例模块 ⏳

- [ ] 抄 GitHub Runner: online/offline/busy 三态
- [ ] 抄 GitHub Runner: Registration Token + config.sh 注册流程
- [ ] 抄 GitHub Runner: Runner Groups + 可见性作用域继承
- [ ] 实例心跳 + 超时下线

### 5.4 容器镜像管理模块 ⏳

- [ ] 抄 ECI ImageCache: 镜像缓存 CRUD + 快照副本 + 淘汰策略
- [ ] 镜像加速 (nydus/dadi/p2p/imc)
- [ ] 镜像仓库凭证管理 (多 registry)

### 5.5 存储桶管理 ⏳

- [ ] S3 auto-key-provision (已有 spec)
- [ ] S3 policy manager (已有 spec)
- [ ] 存储配额 + 用量统计
- [ ] 数据卷扩容 (cloud_essd / cloud_ssd 性能等级)

### 5.6 网络模块 ⏳

- [ ] 安全组规则 DAG (iptables 模型)
- [ ] 入/出带宽限制 (bps)
- [ ] 多可用区调度 (VSwitchOrdered / VSwitchRandom)

---

## 6. 参考模型文档 (SPEC/) ✅

- [x] ECI 容器组生命周期形式化模型 + 真值表
- [x] GitHub Actions WorkflowRun 形式化模型 + 真值表
- [x] GitHub Actions Runner / Secret / Artifact / Cache 模型
- [x] RHEL 权限形式化模型
- [x] DAC × 日志协作形式化验证
- [x] SELinux 形式化模型
- [x] dmesg/journald 日志系统形式化模型
- [x] K8s Pod 生命周期形式化模型
- [x] systemd Unit 生命周期形式化模型
- [x] iptables 规则链形式化模型
- [x] Airflow 架构形式化模型
- [x] ECI × K8s Pod 对比分析
- [x] 重构计划 (REFACTOR_PLAN.md)
