# 改进计划

> 架构：CEA（编译期穷举完备性）+ Airflow KubernetesExecutor 模式  
> Pod 是完整生命周期管理系统，Sandbox 是单容器便利包装器

---

## 0. 设计思路

### 核心问题

重构前，系统有三套独立概念各自为政：

```
Sandbox (单容器)    Pod API (旧, docker-compose)    Actions (Workflow)
     │                      │                            │
     ▼                      ▼                            ▼
  SandboxService        PodResolver                  DagScheduler
  (完整生命周期)         (无持久化, 纯转换)            (DAG 编排)
     │                      │                            │
     └──────────────────────┴──────────┬─────────────────┘
                                       ▼
                              IContainerProvider
                              (create/describe/delete)
```

三个入口、两套状态模型（SandboxStatus vs 无状态）、三种输入格式（CreateSandboxInput vs 旧 PodSpec vs WorkflowDef）。Actions 创建 Sandbox 时绕过了 Pod API，Pod API 创建容器时没有生命周期管理。

### 目标架构

**Action 是调度大脑，Pod 是执行载体，Sandbox 是包装器。**

```
                         Actions (WorkflowDef → WorkflowRun → JobRun)
                              │
                              │ DagScheduler (Airflow 模型)
                              │ 5-step filter / Pool / TriggerRule
                              │
                              ▼
                    ┌─────────────────────┐
                    │    PodService       │  ← 唯一创建入口
                    │    (provision /     │
                    │     stop / start /  │
                    │     terminate /     │
                    │     syncRuntime)    │
                    │                     │
                    │  PodStore (OCC)     │  ← 持久化 + 状态机
                    │  PodPhase (5)       │  ← K8s 标准
                    │  GC 路径 (6)        │
                    └────────┬────────────┘
                             │
                    ┌────────┴────────────┐
                    │   PodCodec<TNative> │  ← CEA 编译期穷举
                    │   encode / decode   │
                    │   decodeStatus      │
                    └────────┬────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
         AlibabaPodCodec  PodmanPodCodec  K8sPodCodec
         (RPC params)     (REST JSON)    (V1Pod JSON)
              │              │              │
              ▼              ▼              ▼
         ECI ContainerGroup   Podman Pod    K8s Pod

    ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─

    Sandbox REST API (/api/sandboxes/*)
    │  薄包装器：CreateSandboxInput → PodSpec → PodService.provision()
    │  保持原有端点不变，内部全部委托给 PodService
    │
    Pod REST API (/api/sandboxes/pod → 未来 /api/pods)
    │  直接 PodSpec 输入 → PodService.provision()
    │  完整生命周期：phase / conditions / containers / events
```

### 分层职责

| 层 | 职责 | 状态模型 |
|---|---|---|
| **Actions** | DAG 编排、调度策略、重试、TriggerRule | TaskInstanceState (13, Airflow) |
| **PodService** | 容器组完整生命周期、持久化、GC、配额 | PodPhase (5, K8s) + PodCondition |
| **PodCodec** | PodSpec ↔ Provider native format 双向转换 | 无状态（纯函数） |
| **Provider** | 云资源 CRUD（ECI/Podman/K8s） | ContainerGroupState (14, 内部) |
| **Sandbox** | 单容器便利包装器 | 委托 PodService，自身无状态 |

### 关键设计决策

**1. PodSpec 是唯一信源。** 所有容器组创建（Actions/Template/Sandbox/Pod API）最终都转换为 PodSpec → PodService.provision()。不存在 CreateContainerGroupInput 之类的中间格式。

**2. PodPhase 是对外状态，SandboxStatus 是内部实现细节。** 通过 π: SandboxStatus(11) → PodPhase(5) 投影，外部只看 5 态，Provider 内部保留 11 态粒度用于计费/审计。

**3. PodCodec 是 CEA 核心契约。** `implements PodCodec<TNative>` 强制 encode + decode + decodeStatus 同步存在。新增 PodSpec 字段 → 所有 codec 编译报错 → 必须各自实现。

**4. Provider 扩展字段走 providerOverrides。** `spotStrategy`/`eipBandwidth` 是 Alibaba 专属，放 `providerOverrides.alibaba`。`sharedNamespaces`/`exitPolicy` 是 Podman 专属，放 `providerOverrides.podman`。通用字段（priority/nodeSelector/dnsConfig）放 PodSpec.spec。

**5. Sandbox API 不变。** 外部行为完全保留，内部从 SandboxService 自有逻辑改为 PodService 委托。迁移对调用方透明。

### 与形式化模型的关系

| SPEC 文档 | 对应实现 |
|---|---|
| 013 K8s Pod Lifecycle | PodPhase(5) + PodCondition(5) + ContainerState(3) |
| 001 ECI Lifecycle | SandboxStatus(11) + ContainerGroupState(14) |
| 016 Airflow Architecture | DagScheduler + TaskInstanceState(13) + 5-step filter + Pool |
| 018 ECI × K8s Comparison | π: SandboxStatus → PodPhase 投影函数 |
| 027 ECI Codec Refactor Plan | PodCodec 双向 Codec 表（原 eci-codec.ts 模式升级） |

---

## 1. Pod 核心架构

### 1.1 类型层 ✅

- [x] `core/pod/types.ts` — PodSpec / PodRuntime / PodEntity / PodPhase(5) / PodCondition(5) / ContainerState(3) / PodNetwork / PodEvent
- [x] `core/pod/types.ts` — π: SandboxStatus(11) → PodPhase(5) 投影（SPEC 018 §8）
- [x] `core/pod/types.ts` — `priority` / `nodeSelector` 字段
- [x] `core/pod/types.ts` — ContainerSpec 复用 `EnvVar` / `ProbeSpec` / `ContainerPortConfig` / `VolumeMountConfig`

### 1.2 Codec 接口层 ✅

- [x] `core/pod/codec.ts` — `PodCodec<TNative>` 接口：`encode` + `decode` + `decodeStatus` + `encodePartial`
- [x] 编译期保证：`implements PodCodec<T>` → 新增 PodSpec 字段即报 `Property missing`

### 1.3 持久化层 ✅

- [x] `core/pod/store.ts` — PodStore：OCC 持久化、索引管理、phase 转换
- [x] `core/pod/service.ts` — PodService：provision / stop / start / terminate / syncRuntime / getById / list
- [x] PodService 支持 IProviderRegistry 动态解析 provider

### 1.4 Alibaba 实现 ✅

- [x] `providers/alibaba/pod-codec.ts` — AlibabaPodCodec implements PodCodec<Record<string,string>>
- [x] adapters: PodSpec → CreateContainerGroupInput / ContainerGroupRuntime → PodRuntime
- [x] `priority` → HBI_PRIORITY 环境变量注入

### 1.5 Provider 接入 ✅

- [x] `IContainerGroupProvider.createPod(PodSpec)` 新接口
- [x] `AlibabaEciContainerGroupProvider.createPod()` 使用 AlibabaPodCodec.encode() → RPC
- [x] `PodmanContainerGroupProvider.createPod()` bridge → CreateContainerGroupInput → createGroup()

### 1.6 Sandbox → PodService 包装 ✅

- [x] `SandboxService` 接受可选 `PodService`，provision 自动委托
- [x] `features/sandbox/index.ts` + `features/template/index.ts` 注入 PodService
- [x] Sandbox REST API 外部行为不变，内部走 PodService 统一生命周期

### 1.7 清理 ✅

- [x] `assembly/pod-resolver.ts` 删除
- [x] `handler.ts` 移除 PodResolver 导入
- [x] `POST /api/sandboxes/pod` 接受新 PodSpec（K8s-aligned）

---

## 2. 状态机修复

### 2.1 ContainerGroupState 统一 ✅

- [x] `ContainerGroupStatus`(type, 12) 合并入 `ContainerGroupState`(enum, 14)，单一信源
- [x] `ContainerGroupRuntime.status` 改用 `ContainerGroupState` enum

### 2.2 mapProviderStatus 删除 ✅

- [x] `mapProviderStatus` 删除，改用 `toSandboxStatus`（与形式化模型一致）
- [x] Bug 修复：`ScheduleFailed → Failed` → `ScheduleFailed → ScheduleFailed`
- [x] 补：`Terminating → Terminating`、`Deleted → Deleted`、`Stopped → Succeeded`、`Paused → Succeeded`

### 2.3 syncRuntime 收敛 ✅

- [x] `Terminating → Deleted` 收敛规则（T15）
- [x] 4 个分立的收敛规则合并为 2 个

---

## 3. Pod API 补齐（待办）

### 3.1 Pod API 接 PodService ✅

Pod API (`/api/sandboxes/pod`) 当前直调 provider，无持久化/状态机/GC。需要接上 PodService：

- [x] `POST /pod` → `podService.provision(PodSpec)` → 返回 `PodEntity` + `PodPhase`
- [x] `GET /pod/:id` → `podService.getById()` → 返回 `PodRuntime`（phase + conditions + containers）
- [x] `POST /pod/:id/stop` → `podService.stop()` → phase 转换
- [x] `DELETE /pod/:id` → `podService.terminate()` → Terminating → Deleted
- [x] `POST /pod/:id/sync` → `podService.syncRuntime()` → 状态收敛
- [x] 响应格式从 `ContainerGroupRuntime` 升级为 `PodRuntime`（含 PodPhase + PodCondition）

### 3.2 Pod API 缺失端点 ✅

- [x] `GET /pod/:id/logs` — 容器日志（Sandbox 层已有，Pod 层缺）
- [x] `GET /pod/:id/exec` — WebSocket exec（已规划，待实现）
- [x] `PATCH /pod/:id` — 部分更新 PodSpec

### 3.3 Sandbox API 响应升级 ✅

- [x] `GET /api/sandboxes/:id` 响应增加 `podPhase` 字段（从 PodService 投影）
- [x] `GET /api/sandboxes` 列表增加 `podPhase` 过滤参数

---

## 4. PodmanPodCodec ⏳

Alibaba 已完成，Podman 需要同等实现：

- [ ] `providers/podman/pod-codec.ts` — PodmanPodCodec implements PodCodec<PodmanCreateRequest>
- [ ] `encode(PodSpec)` → Podman pod create JSON body（含 initContainers、terminationGracePeriod、dnsConfig）
- [ ] `decode(podman inspect JSON)` → PodRuntime
- [ ] `decodeStatus(raw)` → PodPhase
- [ ] `PodmanContainerGroupProvider.createPod()` 使用 PodmanPodCodec

---

## 5. 类型补全

### 5.1 CreateContainerGroupInput 消除 ✅

当前 PodSpec → CreateContainerGroupInput → RPC params 是双层转换，应压缩为 PodSpec → RPC params 直连：

- [x] `AlibabaPodCodec.encode()` 直接输出 `Record<string,string>`（跳过 CreateContainerGroupInput）
- [x] `buildCreateParams` 改为接收 `PodSpec` 输入 — 新增 `buildPodCreateParams(spec: PodSpec, region: string)`
- [x] `CreateContainerGroupInput` 标记 `@deprecated`，最终删除

### 5.2 PodSpec 补缺失字段 ✅

- [x] `spec.topologySpreadConstraints` — 多可用区分布约束
- [x] `spec.affinity` — Pod 亲和/反亲和
- [x] `spec.tolerations` — 容忍节点 taint
- [x] `spec.preemptionPolicy` — 抢占策略

### 5.3 VolumeType 补 ConfigMapVolume / SecretVolume ✅

SPEC `container_dep_spec.txt` 定义了 7 种卷类型，当前 enum 只有 5 种：
- [x] `VolumeType` 补 `OSSVolume` / `ConfigMapVolume`（K8s 通用）
- [x] 新增 `ConfigMapVolumeConfig` / `OSSVolumeConfig` 接口
- [x] `Volume` 实体 + `CreateVolumeInput` / `UpdateVolumeInput` 补对应字段

---

## 6. ESLint / CEA 基础设施

### 6.1 剩余文件清理 ✅

- [x] `eci-container.ts` — 删除 `strVal`，用 `decStr` from eci-codec
- [x] `oss-openapi.ts` — `.catch()` → `.parse()`，用 `decStr` from eci-codec
- [x] `env.ts` — 删除 `narrowOverride`，用 `AppConfigSchema.partial().parse()`
- [x] `queue/consumer.ts` — 类型安全修复（switch-based dispatch + Zod payload validation）

### 6.2 Brand type 断言冲突 ✅

- [x] `as PodId` / `as SandboxId` 工厂函数违反 `consistent-type-assertions: never`
- [x] 设计 CEA 合规的 brand type 方案（Zod `.brand()`）
- [x] 已迁移：PodId, SandboxId, VolumeId, MetricSnapshotId, RegionId, ZoneId, ClusterId, InstanceId, NetworkId, LogId, VersionId, SerializedBody, Facility, OrderId

---

## 7. GC / 健康检查 迁移 ✅

当前 GC 在 SandboxService/sandbox-store，需要迁移到 PodService：

- [x] GC 决策树基于 `PodPhase` 而非 `SandboxStatus`
- [x] 健康检查 syncRuntime 收敛使用 `PodPhase`
- [x] GC 路径：provider-gone / stopped-gc / failed-gc / terminating-gc / stuck-gc / exited-gc / unhealthy-gc / expired-gc

---

## 8. Actions × Pod 统一入口 ✅

Airflow KubernetesExecutor 模式最终目标：

- [x] `JobOperator` 使用 `PodService.provision()` 替代 `SandboxService.provision()`
- [x] WorkflowRun Step → Pod 创建有完整生命周期追踪
- [x] Actions 和 Template apply 共享同一个 PodService 实例

---

## 9. 已完成模块（摘要）

| 模块 | 文件数 | 说明 |
|---|---|---|
| Pod 核心类型 | 3 | types.ts + codec.ts + service.ts + store.ts |
| Alibaba PodCodec | 2 | pod-codec.ts + eci-group-provider.ts |
| 状态机修复 | 3 | container-lifecycle.ts + types.ts + sandbox.service.ts |
| API 迁移 | 2 | handler.ts (Pod API) + sandbox.service.ts (bridge) |
| 清理 | 1 | pod-resolver.ts 删除 |
