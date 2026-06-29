# Pod × Sandbox 统一架构方案

> 触发：Sandbox API 与 Pod API 当前有 6 个重叠端点各自实现，互相各有对方没有的操作，形成"双向各有独有功能"的奇观。
> 终态：Pod 是正版 K8s API 全集，Sandbox 是 Pod 的 ECI 精化薄包装——所有 compute 操作走 PodService，Sandbox 只叠加 11 态状态机 + 配额 + 审计 + 资源级权限。

---

## 1. 形式化规约（来自 SPEC 已有文档）

### 1.1 ECI × K8s Pod 对照（`ECI_VS_K8S_POD_COMPARISON.md`）

**ECI ContainerGroup 就是 K8s Pod**——阿里云在 Pod 语义之上包装了自己的 API。

```
ECI: 11 状态 S₁₁ = {Scheduling, ScheduleFailed, Pending, Running, Succeeded, Failed, Restarting, Updating, Terminating, Expired, Deleted}
K8s: 5 Phase  P₅ = {Pending, Running, Succeeded, Failed, Unknown}

投影 π: S₁₁ → P₅
  Scheduling/ScheduleFailed/Pending → Pending
  Running/Restarting/Updating/Terminating → Running
  Succeeded → Succeeded
  Failed/Expired → Failed
  Deleted → (removed)
```

ECI 是 K8s 的精化（refinement）——K8s 每个 phase 内部都有 ECI 子状态细分，用途是计费粒度。

### 1.2 K8s Pod API 规范（`K8S_POD_LIFECYCLE_MODEL.md`）

三层嵌套状态：Phase(5) → Conditions(4+) → Container(3)。
标准操作：create / get / list / update / delete / exec / log。
K8s 没有 restart——Pod 不支持 restart，删 Pod 靠控制器重建。K8s 没有 stop——只有 delete。

### 1.3 本项目 ContainerGroup 真值表（`CONTAINER_GROUP_LIFECYCLE_TRUTH_TABLE.md`）

11 态 SandboxStatus + 6 条 GC 路径决策树。本项目的 Sandbox 状态机就是 ECI 11 态模型。

### 1.4 项目参考价值（`ECI_VS_K8S_POD_COMPARISON.md` §9）

| 应抄 K8s 的 | 应抄 ECI 的 |
|---|---|
| Phase + Conditions 双层结构 | 11 个显式状态（计费/审计） |
| Probes (liveness/readiness/startup) | 直接声明式 Volume |
| 权限三层门控 DAC→Cap→MAC | 镜像缓存 API |

---

## 2. 代码现状（2026-06-30）

### 2.1 路由现状

两套 API 共用 `src/features/sandbox/handler.ts`，由 `createSandboxRouter(svc, providers, permissionChecker, podService)` 生成。

**Pod API（`/api/sandboxes/pod`）— 9 个端点：**

| 方法 | 路径 | 操作 | 委派 |
|---|---|---|---|
| POST | `/pod` | 创建 Pod | `podService.provision(spec)` |
| GET | `/pod` | 列出 Pod | `podService.list(phase, limit, cursor)` |
| GET | `/pod/{id}` | 获取 Pod | `podService.getById(podId)` |
| POST | `/pod/{id}/stop` | 停止 Pod | `podService.stop(podId)` |
| DELETE | `/pod/{id}` | 终止 Pod | `podService.terminate(podId)` |
| POST | `/pod/{id}/sync` | 同步状态 | `podService.syncRuntime(podId)` |
| GET | `/pod/{id}/logs` | 容器日志 | `podService.getLogs(podId, ...)` |
| POST | `/pod/{id}/exec` | 执行命令 | `podService.exec(podId, ...)` |
| PATCH | `/pod/{id}` | 更新 PodSpec | `podService.update(podId, specPatch)` |

**Sandbox API（`/api/sandboxes`）— 9 个端点：**

| 方法 | 路径 | 操作 | 委派 |
|---|---|---|---|
| GET | `/` | 列出沙箱 | `svc.list(status, limit, cursor)` + PodPhase 富化 |
| GET | `/{id}` | 获取沙箱 | `svc.getById(id)` + PodPhase 富化 |
| POST | `/{id}/stop` | 停止沙箱 | `svc.stop(id)` **→ 直调 provider** |
| POST | `/{id}/start` | 启动沙箱 | `svc.start(id)` **→ 直调 provider** |
| DELETE | `/{id}` | 删除沙箱 | `svc.terminate(id, actorId)` **→ 直调 provider** |
| POST | `/{id}/sync` | 同步状态 | `svc.syncRuntime(id)` **→ 直调 provider** |
| GET | `/{id}/health` | 容器健康 | `svc.getHealth(id)` **→ 直调 provider** |
| POST | `/{id}/restart` | 重启沙箱 | `svc.restart(id)` **→ 直调 provider** |
| PATCH | `/{id}` | 更新规格 | `svc.update(id, input)` **→ 直调 provider** |

### 2.2 PodService 能力矩阵（`src/core/pod/service.ts`）

PodService 构造函数接受 `IAtomicStore`、`IProviderRegistry`、`IContainerProvider`。

| 方法 | 状态 |
|---|---|
| `provision(spec: PodSpec): Promise<PodEntity>` | ✅ 已有 |
| `getById(podId): Promise<PodEntity \| null>` | ✅ 已有 |
| `list(phase?, limit, cursor?): Promise<{items, nextCursor}>` | ✅ 已有 |
| `stop(podId): Promise<PodEntity>` | ✅ 已有 |
| `start(podId): Promise<PodEntity>` | ✅ 已有 |
| `terminate(podId): Promise<void>` | ✅ 已有 |
| `syncRuntime(podId): Promise<PodEntity>` | ✅ 已有 |
| `getLogs(podId, ...): Promise<ContainerLogResult>` | ✅ 已有 |
| `exec(podId, ...): Promise<{execId, webSocketUri?}>` | ✅ 已有 |
| `update(podId, specPatch): Promise<PodEntity>` | ✅ 已有 |
| `restart(podId): Promise<PodEntity>` | ❌ 缺失 |
| `getHealth(podId): Promise<readonly PodHealth[]>` | ❌ 缺失 |

### 2.3 SandboxService 与 PodService 的关系

`SandboxService` 构造函数（`src/features/sandbox/sandbox.service.ts:73`）已有 `podService?: PodService` 字段，但**只在一处使用**：

```
provision()  line 254:  const pod = await this.podService.provision(podSpec);
stop()       line 337:  const provider = await this.#resolveProvider(...);  // 不走 PodService
start()      line 360:  const provider = await this.#resolveProvider(...);  // 不走 PodService
terminate()  line 427:  const provider = await this.#resolveProvider(...);  // 不走 PodService
restart()    line 529:  const provider = await this.#resolveProvider(...);  // 不走 PodService
syncRuntime() line 600: const provider = await this.#resolveProvider(...);  // 不走 PodService
update()     line 556:  const provider = await this.#resolveProvider(...);  // 不走 PodService
getHealth()  line 508:  const provider = await this.#resolveProvider(...);  // 不走 PodService
```

**8 个方法绕过 PodService 直接调 provider。**

### 2.4 权限对比

| | Pod 路由 | Sandbox 路由 |
|---|---|---|
| 资源名 | `'sandbox'` | `'sandbox'` |
| resourceOwnerId | 不传 | 传 `sandbox?.config?.creatorId`（仅写操作） |
| 检查粒度 | 通用 CRUD | 通用 CRUD + 资源级 owner 校验 |

---

## 3. 差异矩阵：SPEC 规定 vs 代码实现

| 操作 | K8s SPEC | ECI SPEC | Pod API 现状 | Sandbox API 现状 | 应归属 |
|---|---|---|---|---|---|
| create | Pod 原生 | CreateContainerGroup | ✅ POST /pod | ❌ 内部 | Pod |
| list | Pod 原生 | DescribeContainerGroups | ✅ GET /pod | ✅ GET / | Pod（Sandbox 透传） |
| get | Pod 原生 | DescribeContainerGroupStatus | ✅ GET /pod/{id} | ✅ GET /{id} | Pod（Sandbox 透传） |
| update | Pod 原生 | UpdateContainerGroup | ✅ PATCH /pod/{id} | ✅ PATCH /{id} | Pod（Sandbox 透传） |
| delete | Pod 原生 | DeleteContainerGroup | ✅ DELETE /pod/{id} | ✅ DELETE /{id} | Pod（Sandbox 透传） |
| exec | Pod 原生 | ExecContainerCommand | ✅ POST /pod/{id}/exec | ❌ | Pod |
| logs | Pod 原生 | DescribeContainerLog | ✅ GET /pod/{id}/logs | ❌ | Pod |
| sync | K8s status subresource | DescribeContainerGroupStatus | ✅ POST /pod/{id}/sync | ✅ POST /{id}/sync | Pod（Sandbox 透传） |
| start | ❌ K8s 无 | ECI 无 start API | ❌ | ✅ POST /{id}/start | Pod（provider 能力） |
| restart | ❌ K8s 无 | RestartContainerGroup | ❌ | ✅ POST /{id}/restart | Pod（provider 能力） |
| health | ❌ K8s 无 | ❌ ECI 无 | ❌ | ✅ GET /{id}/health | Pod（provider 能力） |

**问题根源**：PodService 的 `start()` 方法已实现但 Pod API 没暴露路由；PodService 缺少 `restart()` 和 `getHealth()` 方法。SandboxService 的 8 个方法绕过 PodService 直接调 provider，形成了第二套实现。

---

## 4. 重构方案

### 4.1 目标架构

```
Pod API (正版 K8s, 全集, /api/sandboxes/pod)
├── CRUD: create / list / get / update / delete
├── Ops:  exec / logs / sync
├── Life: start / stop / restart / health
├── Perm: DAC→Cap→MAC 三层门控（resource='pod'）
└── Phase: 5 态 K8s Phase

Sandbox API (Pod 包装器, /api/sandboxes)
├── 全部 compute 操作透传 PodService
├── + 11 态 ECI 状态机（transition 校验）
├── + 配额 QuotaService
├── + 审计 AuditWriter
├── + 资源级权限（creatorId scoping）
└── + π: S₁₁→P₅ 投影（PodPhase 富化）
```

### 4.2 Phase 1: PodService 补全

**文件: `src/core/pod/types.ts`**

追加 `PodHealth` 接口（PodService 在 `core/` 层，不能 import `features/sandbox/interfaces.ts` 的 `ContainerHealth`）：

```typescript
export interface PodHealth {
  readonly containerName: string;
  readonly status: string;
  readonly ready: boolean;
  readonly startedAt?: string | undefined;
  readonly message?: string | undefined;
}
```

**文件: `src/core/pod/service.ts`**

追加两个方法，遵循现有 PodService 风格（get→validate→provider→return）：

`restart(podId)`:
- 取 pod，无则 404
- 无 providerId 则 400
- resolveProvider，无 restart 方法则 501
- 调 `provider.restart(pod.providerId)`（best-effort，失败不抛）
- 返回最新 entity
- **不调 `store.transition()`**——K8s Pod 无 Restarting phase，容器级状态内部周转

`getHealth(podId)`:
- 取 pod，无则 404
- Running 态先 syncRuntime（stale OK）
- 非 Pending/Running 的 pod → 全部 container status='stopped'
- Running/Pending → 逐容器映射 state→health
- 无 provider 调用——从已缓存的 container state 推导

### 4.3 Phase 2: Pod API 路由补全

**文件: `src/features/sandbox/handler.ts`**

在现有 Pod 路由区（`/pod/{id}/sync` 和 `// ─── Sandbox API ───` 之间）插入 3 个端点：

```
POST /pod/{id}/start   → podService.start(podId)
POST /pod/{id}/restart → podService.restart(podId)
GET  /pod/{id}/health  → podService.getHealth(podId)
```

所有端点照搬现有 Pod 路由模式：`requirePerm()` → `notConfigured()` → `createPodId(c.req.param('id'))` → `podService.xxx()` → `c.json(ok(...))`。

Pod API 从 9 个端点变为 **12 个**。

### 4.4 Phase 3: SandboxService 瘦身

**文件: `src/features/sandbox/sandbox.service.ts`**

每个方法加委派分支，模式统一：

```typescript
if (this.podService && sandbox.podUid) {
  // 委派 PodService
  await this.podService.xxx(createPodId(sandbox.podUid));
} else {
  // 保留现有 #resolveProvider() 直调（向后兼容）
}
```

**stop()**: PodService 委派时跳过 `stopIsDelete/ECI` 分支——PodService.stop() 已处理。之后 transition Succeeded 不变。

**start()**: PodService 委派时跳过 `provider.lifecycle.startable` 检查——PodService.start() 内部处理。之后 transition Running 不变。

**restart()**: 先调 `podService.restart()`（不改变 Pod phase），再 transition SandboxStatus.Restarting（维持 11 态语义）。

**getHealth()**: 委派 `podService.getHealth()` 后将 `PodHealth[]` 映射为 `ContainerHealth[]`（字段完全相同，类型不同）。无需 provider 调用。

**syncRuntime()**: 先调 `podService.syncRuntime(podUid)` 更新 Pod 实体，然后保留现有 `provider.describe()` 获取原始 `ContainerGroupRuntime` 做 sandbox 映射（Sandbox 需要原始 runtime 数据做容器/网络/事件映射，这部分逻辑不变）。

**terminate()**: 委派 `podService.terminate()` 处理 provider delete + Pod 级状态，Sandbox 侧执行 `transition(Deleted)` + `removeFromIndex` + `logTerminated`。保留 S3 key 清理、GC retry 队列、idempotent 检查。

**update()**: 需要一个小映射函数 `partialInputToPodSpecPatch()` 将 `Partial<CreateSandboxInput>` 转为 `Partial<PodSpec>`（约 20 行）。之后委派 `podService.update()`。Sandbox 侧的 config merge 保留。

### 4.5 Phase 4: 权限对齐

**文件: `src/features/sandbox/handler.ts`**

所有 12 个 Pod 路由：`requirePerm(c, checker, action, 'sandbox')` → `'pod'`。

需要先读 pod 拿 creatorId 再传 resourceOwnerId 的路由（6 个）：
- `GET /pod/{id}` → `requirePerm(c, checker, 'read', 'pod', pod?.creatorId)`
- `DELETE /pod/{id}` → `requirePerm(c, checker, 'delete', 'pod', pod?.creatorId)`
- `POST /pod/{id}/stop/start/restart/sync` → `requirePerm(c, checker, 'update', 'pod', pod?.creatorId)`
- `GET /pod/{id}/health` → `requirePerm(c, checker, 'read', 'pod', pod?.creatorId)`
- `PATCH /pod/{id}` → `requirePerm(c, checker, 'update', 'pod', pod?.creatorId)`

不传 resourceOwnerId 的（2 个——无单一 owner）：
- `POST /pod`（create）——尚未创建
- `GET /pod`（list）——多资源列表

---

## 5. 文件变更汇总

| 文件 | 变更类型 | 变更量 |
|---|---|---|
| `src/core/pod/types.ts` | 新增 `PodHealth` 接口 | +8 行 |
| `src/core/pod/service.ts` | 新增 `restart()`, `getHealth()` | +40 行 |
| `src/features/sandbox/handler.ts` | 新增 3 路由 + 12 路由改 resource 名 + 6 路由加 creatorId | +60 行 / ~20 行修改 |
| `src/features/sandbox/sandbox.service.ts` | 7 个方法加 PodService 委派分支 + 小映射函数 | +80 行 |

总变更量 ~200 行，无破坏性变更（所有委派分支有 fallback 路径）。

---

## 6. 向后兼容

- `SandboxService` 构造函数的 `podService?: PodService` 已是可选字段
- 所有委派分支格式：`if (this.podService && sandbox.podUid) { 委派 } else { 保留现有 }`
- `sandbox.podUid` 在 `provision()` 的 PodService 路径中已写入（line 280），在 `#resolveProvider()` 路径中不存在
- 不传 `podService` 的环境行为完全不变

---

## 7. 关联 SPEC 文档

| 文档 | 相关性 |
|---|---|
| `ECI_VS_K8S_POD_COMPARISON.md` | ECI=K8s 精化，11 态→5 态投影 |
| `K8S_POD_LIFECYCLE_MODEL.md` | K8s Pod 三层状态 + 标准操作集 |
| `ECI_LIFECYCLE_FORMAL_MODEL.md` | ECI 18 条转移规则 + API 操作列表 |
| `CONTAINER_GROUP_LIFECYCLE_TRUTH_TABLE.md` | 本项目 11 态 SandboxStatus 真值表 |
| `preview_container_gp_dep_spec.md` | ContainerGroup v1 多服务编排 proposal |
| `REFACTOR_PLAN.md` | 权限×日志×审计 6 阶段重构 |
| `GITHUB_RUNNER_MODEL.md` | Runner 3 态 + busy 标志（实例 API 参考） |

---

> 2026-06-30 — 基于 SPEC 形式化模型对比代码现状，发现 SandboxService 的 8 个方法绕过 PodService 直调 provider，形成双轨实现。方案：PodService 补全 2 方法 → Pod API 补全 3 路由 → SandboxService 7 方法加委派分支 → 权限对齐。全部向后兼容。
