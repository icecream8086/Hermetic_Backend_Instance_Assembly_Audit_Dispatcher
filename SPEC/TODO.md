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

### 2.1 Task 泛型类型 + TaskInstance 统一状态机 ✅

- [x] `core/dag/types.ts` (新建) — 统一 `Task` (operator) + `DagRun` (运行实例) + `TaskInstanceState` 合并 Airflow 13 态 + GHA 6 态 = 12 态
- [x] `core/scheduler/task-instance.ts` (新建) — TaskInstance 状态机:
      NONE → SCHEDULED → QUEUED → RUNNING → SUCCESS / FAILED / UP_FOR_RETRY → (回到 QUEUED)
      + SKIPPED + UPSTREAM_FAILED + DEFERRED + RESTARTING + REMOVED
      `VALID_TRANSITIONS` 映射 + `transition(from, to)` + `markSuccess/markFailed/...` helper
- [x] Task 定义: id / name / operatorType / config / dependsOn / triggerRule / retries / pool / timeout
- [x] DagRun 定义: id / dagId / status / executionDate / trigger / env
- [x] `SchedulerContext` / `ITaskExecutor` 接口定义
- [x] `tests/core/scheduler/task-instance.test.ts` — 17 个测试

### 2.2 TriggerRule 引擎 ✅

- [x] `core/dag/trigger-rule.ts` (新建) — 抄 Airflow 9 种触发规则:
      all_success / all_failed / all_done / one_success / one_failed
      / none_failed / none_skipped / none_failed_min_one_success / always
- [x] `evaluateTriggerRule(rule, upstreamStatuses[])` 纯函数
- [x] `tests/core/dag/trigger-rule.test.ts` — 12 个测试

### 2.3 主调度循环 ✅

- [x] `core/scheduler/dag-scheduler.ts` (新建) — 抄 Airflow `SchedulerJobRunner._execute()`
      schedule → process → execute → heartbeat 4 阶段主循环
- [x] 调度器状态: start/stop/pause/resume (复用 IScheduler 接口)
- [x] 可插拔定时器 (复用 ITimerBackend 抽象)
- [x] Executor 缓存 + 动态解析

### 2.4 5 步过滤管线 + ConcurrencyMap ✅

- [x] `core/scheduler/filter.ts` (新建) — 抄 Airflow `_executable_task_instances_to_queued()`
      1. Pool slot 检查 → starved_pools
      2. DAG 并发 (max_active_tasks) → starved_dags
      3. Task 并发 (max_active_tis_per_dag) → starved_tasks
      4. DagRun 并发 (max_active_tis_per_dagrun) → starved_task_dagruns
      5. Executor slot (parallelism)
- [x] `core/scheduler/concurrency-map.ts` (新建) — 一次查询, O(1) 并发检查
      dag_run_active_tasks_map / task_concurrency_map / task_dagrun_concurrency_map
- [x] `tests/core/scheduler/concurrency-map.test.ts` — 3 个测试

### 2.5 Pool 信号量 ✅

- [x] `core/scheduler/pool.ts` (新建) — 抄 Airflow Pool 模型
      name / slots / open_slots / occupied_slots + claim/release 操作
- [x] `tests/core/scheduler/pool.test.ts` — 8 个测试

### 2.6 Backfill 引擎 ✅

- [x] `core/scheduler/backfill.ts` (新建) — catchup 历史时间段
      cronToIntervalMs / computeBackfillStart / backfillDagRuns
- [x] `tests/core/scheduler/backfill.test.ts` — 13 个测试

### 2.7 对接 features/actions — Operator 实现 + API 层 ✅

- [x] `features/actions/dag-builder.ts` (新建) — WorkflowDef → DagDef: `buildDagFromWorkflow()` + `createDagRunFromTrigger()`
- [x] `features/actions/job-operator.ts` (新建) — `ITaskExecutor` 实现: 沙箱供应 + Run/Uses/Dns step 执行
- [x] `features/actions/scheduler-context.ts` (新建) — `StoreSchedulerContext`: IAtomicStore 适配 `SchedulerContext` 接口
- [x] `features/actions/handler.ts` — 集成 DagScheduler: `POST /workflows/:id/schedule` 端点
- [x] `tests/features/actions/dag-builder.test.ts` — 8 个测试

---

## 3. 权限系统

### 3.1 能力位体系 ✅

- [x] `core/permission/capability.ts` (新建) — 独立的 Capability 模块: 19 个能力位 + 5 个复合集 + 位操作 + 动作映射
- [x] 用户 → 能力位存储: `PUT /api/permissions/caps/user/:userId` + `GET /caps/user/:userId`
- [x] 能力位继承: 用户组 DAG 聚合 (`user:cap:{userId}` ∪ inherited `group:cap:{groupId}`)
- [x] `#checkCap()` 真正执行 capability 检查 (不再硬编码通过)
- [x] 抄 Linux CAP_*: 19 个命名能力位 (SANDBOX/IMAGE/VOLUME/NETWORK/USER/SYS)

### 3.2 DAC 层完善 ✅

- [x] 资源 owner: `PermissionCheckInput.resourceOwnerId` 传递到匹配逻辑
- [x] `expandSelf()` — `$self` 模式映射到资源 owner (RHEL ACL named user 模型)
- [x] `#checkDac()` — 用户存在性 + 资源所有权检查

### 3.3 sudo 式临时提权 ✅

- [x] `grantTempElevation(userId, durationMs, capabilities)` — 时间 + 能力位范围
- [x] 提权审计: `perm.elevation.granted` 记录 who → what caps → how long
- [x] `checkElevation(userId, requiredCap)` — 检查是否持有有效提权
- [x] RHEL sudoers 映射: who=userId / where=any / as_whom=elevated / what=caps
- [x] `POST /api/permissions/elevate` / `DELETE /elevate/:userId` / `GET /elevations`

### 3.4 路由 ACL 完善 ✅

- [x] wildcard method: `routeMatches()` 支持逗号分隔多方法 + `*` 通配
- [x] path 前缀/精确/正则 三种模式: `matchType: 'prefix' | 'exact' | 'regex'`
- [x] Zod schema + types 更新

### 3.5 权限检查集成到中间件链 ✅

- [x] `core/middleware/permission-gate.ts` (新建) — FILTER.INPUT 3 层门控中间件
- [x] 每层拒绝写 audit: DAC→SYSCALL, Capability→CAPABILITIES, MAC→AVC
- [x] 自动跳过公开路径 (login/register/info/health)
- [x] HTTP method → CRUD action mapping + URL → resource mapping

---

## 4. 日志 × 审计

### 4.1 Cloudflare Workers Logs 集成 ✅

- [x] `core/audit/r2-logger.ts` (新建) — R2AuditLogger: 批量写入 + 查询 + prune + auto-flush
- [x] Logpush → R2: 批量 JSON 序列化到 `audit-logs/{ts}-{id}.json`
- [x] `R2Bucket` 接口抽象 — 可替换为任何 S3 兼容存储

### 4.2 日志轮换 ✅

- [x] `core/audit/rotation.ts` (新建) — journald §9 完整模型
- [x] `SystemMaxUse` (maxTotalBytes) + `SystemMaxFileSize` (maxFileBytes) + `MaxRetentionSec` (maxAgeMs)
- [x] `selectEntriesToPrune()` — 基于年龄+大小的驱逐算法 (oldest-first)
- [x] `pruneBackend()` — 全量扫描 + 批量删除
- [x] `IAuditAdmin.pruneByIds()` — 所有 6 个 logger 实现
- [x] `DEFAULT_ROTATION` (100MB/16MB/7d) + `PRODUCTION_ROTATION` (4GB/512MB/30d)

### 4.3 实时日志 tail ✅

- [x] `core/audit/tail.ts` (新建) — journalctl -f 模型
- [x] `TailSession` — cursor-based 增量消费
- [x] `pollTail()` — 轮询模式 (HTTP long-poll)
- [x] `startTail()` / `stopTail()` — 自动定时轮询
- [x] `createWsTailHandler()` — WebSocket 推送 (tail:batch / tail:ping 消息)

### 4.4 日志命名空间隔离 ✅

- [x] `core/audit/namespace.ts` (新建) — journald §4 字段信任模型
- [x] `NamespacedAuditReader` — per-facility + per-sandbox + per-boot 过滤
- [x] `sandboxLogReader()` / `facilityLogReader()` — 便捷工厂
- [x] `buildSandboxQuery()` / `buildFacilityQuery()` — 查询构造器

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
