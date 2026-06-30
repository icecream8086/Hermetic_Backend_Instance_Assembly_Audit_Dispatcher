# Pod v2 完全体 — 架构定稿与路线图

> 2026-06-30 — 三层架构定论：Sandbox 100% 透传 Pod，Pod 通过 `podSpecToGroupInput` 翻译协议到 Provider v1。

---

## 1. 架构

```
Sandbox API  调试面, /api/sandboxes     Pod API  完全体, /api/sandboxes/pod
│                                       │
├─ creatorId 资源级权限                   ├─ creatorId 资源级权限
├─ 11 态 ECI 状态机                      ├─ 5 态 K8s Phase
├─ π: S₁₁→P₅ PodPhase 富化              ├─ 12 路由: CRUD + exec/logs
│                                       │   + start/stop/restart/health/sync
▼                                       ▼
SandboxService ──→ PodService ──→ podSpecToGroupInput() ──→ IContainerProvider (v1)
│                    │
│ 100% 透传          │ 缺失: quota / audit / event
│                    │
└─ 叠加: audit eventType 前缀
```

Provider 层 `CreateContainerGroupInput` 是活跃契约，`podSpecToGroupInput()` 是其 v2→v1 协议翻译器。

---

## 2. 待实现：治理能力下沉

Pod 当前是纯 compute 层。quota/audit/event 在 SandboxService 中，不在 PodService。

| 能力 | PodService | SandboxService | 目标 |
|---|---|---|---|
| Compute | ✅ | ✅ 透传 Pod | 不变 |
| 状态机 | 5 态 `store.transition` | 11 态 `isValidTransition` | 不变 |
| 配额 | ❌ | QuotaService | **→ PodService** |
| 审计 | ❌ | IAuditWriter | **→ PodService** |
| 事件 | ❌ | EventBus | **→ PodService** |
| 权限 | handler 已做 | handler 已做 | 不变 |

### 2.1 目标态

```
PodService.provision(spec, creatorId?)
  ├── QuotaService.checkQuota(creatorId, cpu, mem)     ← 入口校验
  ├── provider.create(...)
  ├── PodStore.insert(entity)
  ├── QuotaService.recordCreate(creatorId, cpu, mem)    ← 记录消费
  ├── AuditWriter.write('pod.created', ...)
  └── EventBus.dispatch('pod.created', ...)

PodService.terminate(podId)
  ├── provider.delete(...)
  ├── PodStore.remove(podId)
  ├── QuotaService.recordDelete(creatorId, cpu, mem)    ← 释放配额
  ├── AuditWriter.write('pod.terminated', ...)
  └── EventBus.dispatch('pod.deleted', ...)
```

SandboxService 去除自身的 quota/audit/event 调用，由 PodService 承担。

### 2.2 变更清单

| # | 文件 | 操作 |
|---|---|---|
| 1 | `core/quota/quota.ts` | 新文件，从 `features/sandbox/quota.ts` 搬入 core，`maxSandboxes→maxResources` |
| 2 | `features/sandbox/quota.ts` | 删实现，re-export from core |
| 3 | `core/pod/service.ts` | 构造函数加 `quota?`, `audit?`, `eventBus?`；`provision/terminate/stop/start/restart` 嵌入 |
| 4 | `core/pod/service.ts` | `provision(spec, creatorId?)` → populate `PodEntity.creatorId` |
| 5 | `sandbox.service.ts` | 删 quota/audit/eventBus 调用 + 构造参数 |
| 6 | `sandbox/index.ts` | 构造函数调用删对应实参 |
| 7 | `handler.ts` | `POST /pod` 传 `c.var.currentUser?.id` 进 `provision()` |

### 2.3 Sandbox 可选叠加

若需 sandbox-specific 事件（如 `sandbox.provisioned` 区别于 `pod.created`），SandboxService 可选保留 `audit?`/`eventBus?` 仅用于追加一条 sandbox 事件。pod 事件由 PodService 统一发出，不重复。

---

## 3. 远期：权限三层门控

SPEC `RHEL_PERMISSION_FORMAL_MODEL.md` 规定 DAC→Cap→MAC：

```
Layer 1: DAC — requirePerm(action, resource, creatorId)   ← handler 已做
Layer 2: Cap — 能力位 pod:exec / pod:logs / pod:admin      ← 待设计
Layer 3: MAC — label selector 匹配策略 DAG                  ← 待设计
```

---

## 4. 已知缺口

S3 `autoGenerateKeys`：密钥绑定已持久化到 atomic store（供 `terminate` 清理），但生成的密钥未注入容器挂载。旧代码通过 `secretMounts` 数组传给 provider input，PodService 路径下缺失此步骤。需在 `toPodSpec()` 或 `podSpecToGroupInput()` 中补充。

---

> 待实现：QuotaService 入 core → PodService 集成 quota/audit/event，净增 ~50 行。  
> Provider 层 `CreateContainerGroupInput` 是活跃契约，不删。
> 生成的密钥注入容器挂载 ❌ — v1 路径已删，PodService 路径未覆盖[暂不使用]