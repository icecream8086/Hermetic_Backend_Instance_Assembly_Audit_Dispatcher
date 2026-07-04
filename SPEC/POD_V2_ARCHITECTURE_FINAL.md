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

## 2. 治理能力下沉 ✅ DONE (2026-07-04)

quota/audit/event 已全部迁移到 PodService。SandboxService 保留可选 audit/event 仅用于追加 sandbox 前缀事件（Section 2.3 设计）。

## 3. 远期：权限三层门控

SPEC `RHEL_PERMISSION_FORMAL_MODEL.md` 规定 DAC→Cap→MAC：

```
Layer 1: DAC — requirePerm(action, resource, creatorId)   ← handler 已做
Layer 2: Cap — 能力位 pod:exec / pod:logs / pod:admin      ← 待设计
Layer 3: MAC — label selector 匹配策略 DAG                  ← 待设计
```

---

## 4. Pod 开发任务

> 合并来源：本文件 §4 + `platform-secret-provisioner.md` §11 + `storage-sync-api.md` §7 + code audit

---

### 4.1 必做（阻塞性）

#### T1 — `encodeSecretRefs` secrets Map 管线

**文件**: `eci-codec.ts:700,918`, `pod/service.ts:32`, `provider/types.ts:348`

`encodeSecretRefs(refs, params, volumeBase, secrets?)` 的 `secrets` 参数未传——ECI standalone 降级内联写入空 Payload。

**修法**:
1. `CreateContainerGroupInput` 或 `PodSpec` 携带 `resolvedSecrets` Map
2. `buildCreateParams` / `buildPodCreateParams` 传 secrets 给 `encodeSecretRefs`
3. applicator → sandbox.service → pod.service 管线透传

**来源**: `platform-secret-provisioner.md` Phase 1

#### T2 — `parseVolumes` 补充 SecretVolume/ConfigMapVolume

**文件**: `eci-codec.ts:582`

ECI 支持 SecretVolume/ConfigMapVolume（入站编码完整），但出站 `parseVolumes()` 只解析 NFS + EmptyDir。

**修法**: `parseVolumes` 增加 `v.SecretVolume` 和 `v.ConfigMapVolume` 分支。

**来源**: code audit + `platform-secret-provisioner.md` §11.2

---

### 4.2 功能完整

#### T3 — PodSpec scheduling fields → Codec

**文件**: `eci-codec.ts` (ECI), `podman-provider.ts` (Podman)

PodSpec 已定义的 11 个 K8s scheduling 字段未编码：

| 字段 | ECI 映射 | Podman | 工作量 |
|---|---|---|---|
| `priority` | env HBI_PRIORITY | pod ordering | 小 |
| `nodeSelector` | 忽略 | instance label match | 小 |
| `terminationGracePeriodSeconds` | ECI API | `--time` | 小 |
| `dnsConfig` | `DnsConfig` | `--dns` | 小 |
| `hostAliases` | `HostAliase` | `--add-host` | 小 |
| `topologySpreadConstraints` | `ScheduleStrategy` (部分) | N/A | 中 |
| `affinity` | N/A | label select | 大 |
| `tolerations` | N/A | N/A | — |
| `preemptionPolicy` | N/A | N/A | — |

各字段独立，可按行拆分。

#### T4 — Podman Secret Backend

**文件**: `core/security/secret-provisioner.ts` (新增 Backend), `podman-provider.ts` (提取)

从 `podman-provider.ts` 的 `podman secret create` + `--secret` 逻辑提取为 `PodmanSecretBackend implements PlatformSecretBackend`。

**来源**: `platform-secret-provisioner.md` Phase 2 (Provisioner)

#### T5 — SecretProvisioner 注册到 app.ts

**文件**: `src/core/app.ts`

创建 `SecretProvisioner` 实例，注册 `EciSecretBackend`，加入 event-loop tick 调用 `syncAll()`。

**来源**: `platform-secret-provisioner.md` Phase 2 (Provisioner)

#### T6 — 存储同步 REST API

**文件**: `src/features/storage/` (新建 feature)

4 个端点：`GET /files`, `POST /diff`, `POST /presign`, `DELETE /files/{key}`。

**来源**: `storage-sync-api.md`

---

### 4.3 清理

#### T7 — ECI SPEC 勘误

**文件**: `ECI_VS_K8S_POD_COMPARISON.md:73`

```
- ECI Volume 支持 NFS，但不支持 ConfigMap/Secret 卷类型
+ ECI Volume 支持 NFS/ConfigMap/SecretVolume
```

#### T8 — ContainerSpec / ContainerConfig 类型去重

**文件**: `core/pod/types.ts`, `features/sandbox/types.ts`

`ContainerSpec` 与 `ContainerConfig` 有 ~14 个相同字段。`PodNetwork`(4) 与 `NetworkInfo`(7) 是超集关系。合并非阻塞但减少维护负担。

#### T9 — K8sSecretBackend + AwsSecretBackend

**文件**: `core/security/secret-provisioner.ts` (新增 Backend)

K8s: K8s API `POST /api/v1/namespaces/{ns}/secrets`。AWS: SDK `SecretsManager.CreateSecret`。后续平台，非阻塞。

**来源**: `platform-secret-provisioner.md` §11.4

---

> **已完成**: QuotaService 入 core ✅ → PodService 集成 quota/audit/event ✅ → S3 autoGenerateKeys 废弃 → S3 JWT V3 ✅
> **开发文档**: `SPEC/DEVLOG-pod-unification.md`