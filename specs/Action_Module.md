**需求规格说明书：全功能 CI/CD 编排与容器化服务交付平台**

---

### 1. 系统目标
构建一个与 GitHub Actions 能力对等的私有 CI/CD 平台，支持通过声明式配置文件定义工作流，在 Podman 容器中执行任务，并提供开放的扩展机制（Actions）。同时提供“共享即服务”能力，允许用户通过受控的匿名链接按需启动短生命周期容器（如游戏服务器），并自动回收资源。底层基础设施基于 Cloudflare 全球网络（Workers、D1、KV、Queues、R2）实现弹性伸缩与事件驱动。

---

### 2. 角色定义

| 角色 | 职责概述 |
|------|----------|
| **平台管理员** | 管理全局配置、Runner 集群、资源配额、审计日志、用户与组织。 |
| **组织/项目管理员** | 管理项目成员、权限、密钥、共享策略上限、资源配额。 |
| **开发者（Owner）** | 定义 Workflow/Action、触发构建、查看运行历史、创建服务共享链接、管理容器实例生命周期。 |
| **外部协作者（已认证）** | 受邀参与特定项目的成员，拥有受限的操作权限（如触发工作流、查看日志）。 |
| **匿名访客（Guest）** | 通过共享链接临时触发服务启动，无需注册，受密码、有效期、次数限制。 |
| **Runner 代理** | 自托管或平台管理的执行节点，拉取任务、运行 Podman 容器并上报状态/日志。 |

---

### 3. 功能需求

#### 3.1 工作流定义与管理
- **配置即代码**：支持 YAML/JSON 定义 Workflow，包含 name、on（触发器）、env、jobs。
- **Job 定义**：每个 Job 指定运行环境标签（runs-on）、依赖（needs）、条件执行（if）、超时、步骤列表。
- **Step 定义**：支持 `uses`（引用 Action）、`run`（内联脚本），具备 inputs、env、continue-on-error、timeout。
- **矩阵策略**：单个 Job 可基于参数组合展开为多个并行 Job。
- **手动审批节点**：支持在 Job 间插入人工审批步骤，需授权后才能继续。
- **可复用 Action**：支持容器 Action、JavaScript Action、复合 Action，并提供注册表与版本化。
- **配置校验**：YAML 语法检查、依赖环检测、Action 引用存在性验证，提供 API 供编辑器实时校验。

#### 3.2 触发器
- **类似于GIt 事件**：监听 Webhook，按工作流定义中的 `on` 规则匹配。
- **计划任务**：支持 Cron 表达式定时触发。
- **手动触发**：通过 UI/API 调度，支持输入参数。
- **HTTP 触发器**：为每个工作流暴露唯一端点（可签名验证），供外部系统调用。
- **共享链接触发**：见 3.8。

#### 3.3 执行引擎（Podman Runner）
- **任务分发**：调度器根据 Job 的 `runs-on` 标签和 Runner 注册标签进行匹配分配。
- **容器编排**：Runner 使用 Podman 创建、启动、监视和销毁容器，支持 rootless 运行。
- **服务容器**：一个 Job 内可附带辅助容器（如数据库），Job 结束时自动清理。
- **工作空间管理**：同一 Workflow 下的 Job 可共享工作目录（通过快照/R2 传递）。
- **缓存管理**：提供依赖缓存的上传与恢复 API，作用域可按分支/Job/操作系统隔离。
- **资源限制**：对每个 Job 的 CPU、内存、磁盘 IO 进行限额，防止相邻干扰。
- **日志流式传输**：stdout/stderr 实时上传，支持分段存储于 R2，通过 API 提供分页和流式读取。

#### 3.4 扩展系统（Actions）
- **Action 规范**：必须定义 name、description、inputs、outputs、runs（using + main/image）。
- **运行时上下文**：JavaScript Action 可访问环境变量、输入参数、工作目录、平台专用 API（如 KV、D1、Secrets）。
- **官方 SDK**：提供封装好的云服务调用库（如 Cloudflare 全家桶操作），降低开发门槛。
- **市场/注册表**：允许发布、发现、安装第三方 Action，支持版本锁定。

#### 3.5 可视化与监控
- **DAG 工作流图**：展示 Run 中所有 Job 的依赖关系与实时状态（节点颜色、动态连线）。
- **步骤详情**：点击节点可展开 Step 列表、每个 Step 的日志、耗时、状态。
- **实时状态推送**：通过 SSE/WebSocket 推送 Job/Step 状态变更，驱动前端更新。
- **仪表盘**：展示历史 Run、成功率、平均执行时间、活跃 Runner 等聚合指标。

#### 3.6 多租户与安全
- **账户模型**：支持 Organization → Project 层级，资源配额可下派。
- **密钥管理**：提供 Secrets API，支持加密存储、按环境注入，日志自动脱敏（如将密钥替换为 `***`）。
- **Podman 安全加固**：强制 rootless，挂载卷白名单，网络策略隔离，可配置 Seccomp/AppArmor/SELinux 模板。
- **访问控制**：基于角色的权限（查看、编辑、执行、管理），支持 OAuth/SSO 集成。

#### 3.7 审计与可观测性
- **审计日志**：全量记录所有关键操作（触发、配置修改、密钥访问、Runner 注册/离线），存储于不可变介质，支持按时间、用户、事件类型查询。
- **Runner 健康监测**：心跳机制，超时未响应则 Job 重调度或标记失败，并通知管理员。
- **任务诊断**：Step 卡死时支持强制终止并导出容器快照（进程状态、最近日志）。
- **资源计费**：记录每个 Run 消耗的 vCPU/内存/存储时长，按 Project 归集，提供成本报表。

#### 3.8 共享服务交付（OneDrive 式匿名启动）
- **服务定义**：Owner 将已有的部署 Action/Workflow 封装为“服务”，包含镜像、环境变量、端口、资源限制、持久化卷。
- **共享链接创建**：Owner 为服务创建临时共享链接，配置：
  - 访问密码（哈希存储）
  - 有效起止时间
  - 最大触发次数（可消耗配额）
  - 每次启动后容器的默认 TTL（存活时间）
- **匿名访问流程**：
  1. Guest 访问链接 → 校验有效性 → 输入密码（若需要）。
  2. 系统展示服务简介与启动按钮。
  3. Guest 点击启动 → 后端触发一次 Workflow Run（标记 trigger=shared_link）→ 创建容器实例。
  4. 页面显示启动进度，完成后返回连接信息（IP:端口）。
  5. 实例启动后即开始倒计时，到期强制 `podman stop/rm` 回收。
- **生命周期管理**：
  - 所有通过共享创建的容器实例记录在册，Owner 可在面板查看并手动终止。
  - 可配置到期前通知（Webhook、UI 提示）。
- **撤销机制**：Owner 可随时禁用链接，立即阻止新启动，并对运行中的实例选择立即终止或自然到期。
- **防滥用**：可设置单链接并发上限、IP 限制、人机验证（Captcha）；记录所有访问日志（时间、IP、结果）。

#### 3.9 开发体验
- **本地执行**：提供 CLI 工具，用本地 Podman 模拟 Workflow，支持断点调试 Step。
- **Workflow 模板**：预置常见场景模板（CI、部署、DNS 更新、共享服务）。
- **Schema 支持**：为 YAML 提供 JSON Schema，配合编辑器智能提示与错误检查。

---

### 4. 非功能需求

| 类别 | 要求 |
|------|------|
| **可靠性** | 工作流触发消息至少投递一次；Runner 故障时 Job 可自动重调度；D1 数据库定期备份，Queue 消息幂等处理。 |
| **可用性** | API 层基于 Cloudflare Workers，全球就近接入，要求 99.9% 可用；Runner 可离线重连并恢复任务状态。 |
| **安全性** | 传输加密（TLS 1.3），静态数据加密（密钥、日志、工件）；密钥不落盘，注入环境即销毁；容器间网络隔离；匿名链接密码加盐哈希存储。 |
| **性能** | 工作流触发至开始执行延迟 < 5s（理想）；日志流延迟 < 2s；DAG 可视化渲染 100+ Job 时流畅。 |
| **可扩展性** | 支持水平扩展 Runner 节点；Workers 无状态可弹性伸缩；通过 Queue 解耦，应对突发高峰。 |
| **可维护性** | 平台组件版本化部署，支持灰度发布；详细操作文档与 OpenAPI 规范。 |

---

### 5. 技术约束
- **容器运行时**：必须使用 Podman（CLI 及 API），支持 rootless。
- **云基础设施**：优先使用 Cloudflare 全家桶——Workers（计算）、D1（关系数据）、KV（键值缓存）、Queues（消息队列）、R2（对象存储）。
- **前端**：需提供 Web UI，与后端 API 交互，实现工作流可视化与共享界面。
- **扩展语言**：Actions 开发支持 JavaScript/TypeScript（直接）和任意语言（通过容器镜像）。

---

### 6. 接口需求概览

- **Workflow 管理 API**：CRUD，含校验端点。
- **触发器 API**：手动触发、HTTP 触发签名验证。
- **Run 查询与日志 API**：分页/流式获取。
- **Runner 注册与心跳 API**：认证、上报标签、状态。
- **Secrets API**：增删改查，引用语法 `${{ secrets.xxx }}`。
- **共享链接 API**：创建、撤销、查询，以及匿名访问验证与启动。
- **Webhook 输出**：工作流状态变化回调用户 URL，支持模板化消息。
- **订阅端点**：SSE/WebSocket 实时推送 Job/Step 状态。

---

### 7. 数据实体概要

- **Workflow** / **Job** / **Step** / **Action**（定义层）
- **WorkflowRun** / **JobRun** / **StepRun**（实例层）
- **Runner**（注册信息、标签、心跳）
- **Secret**（加密 blob，作用域绑定 Project/Organization）
- **Artifact** / **LogSegment**（存储于 R2 的元数据记录）
- **SharedLink**（密码哈希、有效期、配额、关联服务定义）
- **ContainerInstance**（容器 ID、状态、TTL、所属共享链接）
- **AuditEvent**（操作时间、主体、行为、资源、结果）
- **Organization** / **Project** / **User**（租户与权限）

---

**注**：本需求分析聚焦”必须实现什么”，关于具体架构选型、通信协议等技术实现细节见架构设计文档。所有功能均保持一致性，无冗余冲突。

---

## 8. 实施状态

> 更新于 2026-06-22

### 8.1 已完成

#### P0 — 核心引擎 ✅

| spec | 功能 | 文件 | 说明 |
|------|------|------|------|
| 3.1 | Workflow/Job/Step 类型定义 | `types.ts` | WorkflowDef, JobDef, StepDef (run\|uses\|dns 三态), WorkflowRun, JobRun, StepRun |
| 3.1 | YAML 配置 → Zod 校验 | `schema.ts` | CreateWorkflowSchema, UpdateWorkflowSchema, TriggerWorkflowSchema。支持 `container` / `containers` 二选一 |
| 3.1 | Workflow CRUD API | `handler.ts` | POST/GET/PATCH/DELETE，分页 `{ items, total, page, limit }` |
| 3.1 | 手动触发 + Run/Job 查询 | 同上 | POST trigger，GET runs/:id/jobs/:id |
| 3.2 | 手动触发 (manual) | `runner.ts` | WorkflowRunner.startRun() → 创建 Run + JobRun → 入队 Queue |
| 3.3 | 容器创建 + 实例路由 | 同上 | resolveContainer(instanceId) → Provider.create({region, ...}) |
| 3.3 | 容器组 (pod) 支持 | 同上 | `containers: [...]` 映射到 ContainerGroupProvider |
| 3.4 | DNS Step（Action 内部） | `step-dns.ts` | executeDnsStep() 直接调 IDnsProvider |
| 3.5 | 审计日志 | `runner.ts` | IAuditWriter.write()，facility=`workflow-runner`，kern 5-6 |
| — | Queue 集成 | `queue/types.ts`, `consumer.ts` | `workflow:job:run` 类型 + handleWorkflowJobRun() |

#### P1 — 触发器 + 日志 + 注册表 ✅

| spec | 功能 | 文件 | 说明 |
|------|------|------|------|
| 3.2 | Cron 触发器 | `triggers.ts` | 5 字段匹配器，EventBus 自循环 tick |
| 3.2 | HTTP 触发器 + HMAC | 同上 | HMAC-SHA256 `X-Workflow-Signature` |
| 3.2 | Webhook 触发器 | `handler.ts` | branch 匹配 `on.push.branches` |
| 3.3 | Step 日志流式传输 | `logs.ts` | IBlobStore (R2) 分段，dmesg 格式，分页读取 |
| 3.3 | 日志查询 API | `handler.ts` | GET `/jobs/:id/logs?step=&offset=&limit=` |
| 3.4 | Action 注册表 | `registry.ts` | ActionDef CRUD + `name@version` 引用解析 |
| 3.5 | WebSocket 状态推送 | `runner.ts` + `do-bridge.ts` | `workflow:completed` / `workflow:job:status` → DoBridge |
| 3.3 | `run:` 真实执行 | `runner.ts` | `provider.exec(sandboxId, [shell, '-c', script])` |
| 3.4 | `uses:` 解析执行 | `runner.ts` | `ActionRegistry.resolve()` → provider.exec |
| 3.3 | Step 日志写入 | `runner.ts` | `appendStepLog(blob)` 每 step 前后 |
| — | 调度系统核心 | `core/scheduler/dag/` | DagScheduler + 6 策略 + 3 分配器 |
| — | 调度器形式化验证 | `tests/core/scheduler/` | priority-properties (9) + scheduler-properties (13) |

#### P2 — 矩阵 + 多租户 + 共享链接 + Runner ✅

| spec | 功能 | 文件 | 说明 |
|------|------|------|------|
| 3.1 | 矩阵策略 | `matrix.ts` | MatrixExpander — 笛卡尔积 + exclude + `${{ matrix.x }}` |
| 3.1 | 人工审批节点 | `extensions.ts` | ApprovalService — 请求/审核/门控执行 |
| 3.3 | 工作空间共享 | `workspace.ts` | IWorkspaceStore + BlobWorkspaceStore (R2 tar) |
| 3.3 | Runner 注册/心跳 | `runner-registry.ts` | heartbeat + 30s 超时离线 + 标签匹配 + 排水 |
| 3.3 | Runner → Job 调度器 | `core/scheduler/dag/` | RunnerRegistry.toResourceNodes() → DagScheduler |
| 3.3 | 实例路由 (instanceId) | `runner.ts` | resolveContainer(instanceId) → Provider.create({region}) |
| 3.6 | Secrets API | `secrets.ts` | AES-256-GCM + `${{ secrets.KEY }}` |
| 3.6 | 多租户 (Org/Project) | `extensions.ts` | OrgService + ProjectService + OrgQuota 配额 |
| 3.6 | 扩展字段 (metadata/annotations) | `types.ts` | WorkflowDef/JobDef 含 orgId/projectId/ownerId/metadata |
| 3.8 | 共享链接 (SharedLink) | `shared-link.ts` | PBKDF2 + password + TTL + maxUses + 撤销 |
| 3.8 | 匿名 launch + 防滥用 | `handler.ts` | validate → recordUse → trigger → audit |

### 8.2 待实施

| spec | 功能 | 阻塞点 |
|------|------|--------|
| 3.3 | 依赖缓存管理 | 需 Podman volume mount 集成 |
| 3.4 | JS SDK / 运行时上下文 | 独立 SDK 项目 |
| 3.5 | 仪表盘 API | 可 IAtomicStore 做简单聚合 |
| 3.6 | RBAC 中间件挂载 | 基础设施就绪，挂载即用 |
| 3.7 | 任务诊断（容器快照） | 需 Podman checkpoint |
| 3.7 | 资源计费 | 需计量模型设计 |
| 3.9 | CLI / 模板 / Schema | 独立工具链 |

### 8.3 API 全貌（28 endpoints）

```
# Workflow CRUD (5)
POST   /api/actions/workflows
GET    /api/actions/workflows?page=&limit=
GET    /api/actions/workflows/:id
PATCH  /api/actions/workflows/:id
DELETE /api/actions/workflows/:id

# Triggers (3)
POST   /api/actions/workflows/:id/trigger      # 手动
POST   /api/actions/workflows/:id/http          # HTTP+HMAC
POST   /api/actions/webhook                     # Git push

# Runs & Jobs (5)
GET    /api/actions/runs?page=&limit=
GET    /api/actions/runs/:id
GET    /api/actions/runs/:id/jobs
GET    /api/actions/jobs/:id
GET    /api/actions/jobs/:id/logs?step=&offset=&limit=

# Action Registry (2)
POST   /api/actions/actions
GET    /api/actions/actions

# Secrets (3)
POST   /api/actions/workflows/:id/secrets
GET    /api/actions/workflows/:id/secrets
DELETE /api/actions/secrets/:id

# Shared Links (5)
POST   /api/actions/shared-links
GET    /api/actions/shared-links
GET    /api/actions/shared-links/:id
POST   /api/actions/shared-links/:id/launch     # 匿名触发
POST   /api/actions/shared-links/:id/disable

# Runner Registry (4)
POST   /api/actions/runners/heartbeat
GET    /api/actions/runners?labels={}
GET    /api/actions/runners/:id
POST   /api/actions/runners/:id/drain

# Workspace (1)
GET    /api/actions/workspace/:workflowRunId/:jobName

# Orgs & Projects (6)
POST   /api/actions/orgs
GET    /api/actions/orgs?member=
GET    /api/actions/orgs/:id
POST   /api/actions/orgs/:id/members
POST   /api/actions/projects
GET    /api/actions/projects?orgId=

# Approvals (3)
POST   /api/actions/runs/:id/approvals
POST   /api/actions/approvals/:id/decide
GET    /api/actions/runs/:id/approvals
```

### 8.4 存储设计（无 D1）

| 实体 | 存储键 | 索引键 |
|------|--------|--------|
| WorkflowDef | `workflow-def:{id}` | `action:workflow:ids` |
| WorkflowRun | `workflow-run:{id}` | `action:workflow-run:ids` |
| JobRun | `job-run:{id}` | `action:job-run:ids` |
| ActionDef | `action-def:{id}` | `action-def:ids` |
| WorkflowSecret | `action-secret:{id}` | `action-secret:ids` |
| SharedLink | `shared-link:{id}` | `shared-link:ids` |
| RunnerRegistration | `action-runner:{id}` | `action-runner:ids` |
| Organization | `action-org:{id}` | `action-org:ids` |
| Project | `action-project:{id}` | `action-project:ids` |
| ApprovalNode | `action-approval:{id}` | `action-approval:ids` |
| Step 日志 | `action:logs:{jobRunId}/{stepName}` (IBlobStore/R2) | — |
| 工作空间 | `action:workspace:{runId}/{jobName}` (IBlobStore/R2) | — |

### 8.5 完成度统计

| 层级 | spec 覆盖 | 状态 |
|------|-----------|------|
| P0 核心引擎 | 3.1 全部 + 3.2/3.3/3.4/3.5 核心 | ✅ 100% |
| P1 触发器/日志/注册表 | 3.2/3.3/3.4/3.5 扩展 | ✅ 100% |
| P2 矩阵/多租户/共享 | 3.1/3.3/3.6/3.8 | ✅ 100% |
| P2 剩余 | 缓存/RBAC/仪表盘/计费/CLI | 待 P3 |
| **合计 44 项** | **37 完成 / 7 待实施** | **84%** |

---

## 9. 调度系统设计

> 参考 `specs/doc2.md` 调度算法分析。调度系统与 DAG 系统同一优先级，需用形式化验证测试正确性。

### 9.1 三层调度架构

```
┌─────────────────────────────────────────────┐
│  第 1 层 — DAG 编排调度                      │
│  决定 Job 就绪顺序，优化 makespan             │
│  算法: 拓扑层级 + 关键路径优先 (CPM)           │
│  当前: WorkflowRunner.#enqueueReadyJobs()     │
│  形式化验证: 线性一致性同等级严格性             │
├─────────────────────────────────────────────┤
│  第 2 层 — Runner 资源分配                    │
│  决定 Job 分配到哪个 Runner                   │
│  算法: 过滤+打分 (K8s scheduler 模型)          │
│  待建: filter (runs-on, 资源余量, 标签)        │
│        score (LeastRequested, ImageLocality)  │
├─────────────────────────────────────────────┤
│  第 3 层 — Runner 内 Step 执行顺序            │
│  决定单个 Runner 内 Step 的 CPU 时间分配       │
│  算法: FCFS (当前) → MLFQ (未来)              │
│  当前: 容器内命令顺序执行                      │
└─────────────────────────────────────────────┘
```

### 9.2 实现状态

| 层级 | 当前实现 | 算法 | 形式化验证 |
|------|----------|------|------------|
| DAG 编排 | `src/core/scheduler/dag/dag-scheduler.ts` | DagScheduler + 6 策略 + 3 分配器 | ✅ `scheduler-properties.test.ts` (13 属性) |
| 优先级调度 | `PriorityStrategy` | 高优先先执行，同优先 FCFS | ✅ `priority-properties.test.ts` (9 属性) |
| 资源分配 | `FirstFitAllocator` / `LeastRequestedAllocator` / `HeftAllocator` | K8s 风格过滤+打分 | ✅ 容量不超分、makespan 有界 |
| Runner 内执行 | `provider.exec()` | shell 命令容器内执行 | 待建 |

### 9.3 形式化验证结果

与 OCC 线性一致性验证 (`tests/core/store/occ-linearizability.test.ts`) 同等严格性：

| 文件 | 属性数 | 验证内容 | 发现 bug |
|------|--------|----------|----------|
| `tests/core/dag/toposort-properties.test.ts` | 9 | 边序、完备、无环、source/sink、可达子图 | — |
| `tests/core/scheduler/priority-properties.test.ts` | 9 | 降序、无反转、vs-FCFS、同优=FCFS | — |
| `tests/core/scheduler/scheduler-properties.test.ts` | 13 | FCFS/CPM/SJF×各分配器、makespan 边界、确定性、无饥饿 | 1: ready 为空时过早 break（已修复） |

### 9.4 调度系统代码结构

```
src/core/scheduler/
├── interfaces.ts          # ITimerBackend, IScheduler (原有 — EventLoop 定时器)
├── dag/
│   ├── types.ts           # SchedulableTask, ResourceNode, Schedule
│   ├── interfaces.ts      # ISchedulingStrategy, IResourceAllocator, IDagScheduler
│   ├── strategies.ts      # FCFS, Priority, SJF, CPM, HEFT-Priority
│   │                      # FirstFit, LeastRequested, HEFT (资源分配)
│   └── dag-scheduler.ts   # DagScheduler — 事件驱动仿真引擎
tests/core/scheduler/
├── scheduler-properties.test.ts   # 13 属性 — 调度器不变式
└── priority-properties.test.ts    #  9 属性 — 优先级管理
```

### 9.5 数据库配置

> 现阶段不使用 D1。所有存储基于 IAtomicStore (KV/DO) + IBlobStore (R2) + 手动索引。
> D1 接入点为 QueryStore 层（已接线，待启用），后期可用于 Run 历史聚合查询和仪表盘。

---

## 10. 当前完整文件清单

```
src/features/actions/          (16 文件)
├── types.ts                   # 全类型 — 含扩展字段 (orgId/projectId/instanceId/metadata)
├── schema.ts                  # Zod 校验
├── handler.ts                 # Hono 路由 — 28 endpoints + RouteMeta
├── runner.ts                  # WorkflowRunner — DAG调度 + 实例路由 + Step执行 + 审批
├── step-dns.ts                # DNS Step
├── logs.ts                    # Step 日志 — IBlobStore dmesg 格式
├── triggers.ts                # Cron/HTTP/Webhook + HMAC
├── registry.ts                # Action 注册表 + uses: 引用解析
├── secrets.ts                 # WorkflowSecretService — AES-256-GCM
├── shared-link.ts             # SharedLinkService — PBKDF2
├── runner-registry.ts         # RunnerRegistry — 心跳/instanceId/标签
├── matrix.ts                  # MatrixExpander — 笛卡尔积展开
├── workspace.ts               # IWorkspaceStore + BlobWorkspaceStore
├── extensions.ts              # OrgService + ProjectService + ApprovalService + 配额
└── index.ts                   # Feature 入口

src/core/scheduler/dag/        (4 文件)
├── types.ts                   # SchedulableTask, ResourceNode, Schedule
├── interfaces.ts              # ISchedulingStrategy, IResourceAllocator, IDagScheduler
├── strategies.ts              # 6 策略 + 3 分配器 + computeUpwardRanks
└── dag-scheduler.ts           # 事件驱动调度引擎

src/queue/                     (修改 2 文件)
├── types.ts                   # + workflow:job:run
└── consumer.ts                # + handleWorkflowJobRun()

src/core/event-bus/
└── do-bridge.ts               # + workflow:completed / workflow:job:status

tests/core/scheduler/          (2 文件)
├── scheduler-properties.test.ts   # 13 属性
└── priority-properties.test.ts    #  9 属性

http/action.http               # 28 REST Client 请求
openapi.json                   # +22 /api/actions/* 路径
```

### 10.1 完整执行流程

```
Trigger (manual/cron/webhook/http/shared_link)
  → WorkflowRunner.startRun()
    → MatrixExpander.expand() — 矩阵展开
    → 创建 WorkflowRun (Pending) + JobRun(s) (Queued)
    → #enqueueReadyJobs() → Queue: workflow:job:run
  → Consumer: handleWorkflowJobRun()
    → WorkflowRunner.executeJob(jobRunId)
      → ApprovalService — 审批门控 (pending→wait, approved→继续, rejected→Failure)
      → #provisionJobSandbox()
        → resolveContainer(instanceId) — 实例路由
        → Provider.create({ region, instanceId, ... })
      → #executeSteps()
        ├─ run:  → provider.exec(sandboxId, [shell, '-c', script])
        ├─ dns:  → IDnsProvider.updateRecord/deleteRecord
        └─ uses: → ActionRegistry.resolve(ref) → provider.exec(entrypoint)
        └─ 每个 step: appendStepLog(blob, jobRunId, stepName, line)
      → status: Success/Failure
      → EventBus → DoBridge → WebSocket (实时推送)
      → #enqueueReadyJobs() — 检查 needs，触发下游 Job
      → #checkWorkflowCompletion() — 全部完成 → EventBus.dispatch()
```