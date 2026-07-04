# 平台原生密钥注入 — 实现规范 v1

> **Status**: Draft
> **日期**: 2026-07-04
> **基于**: ECI SecretVolume API 实测验证 (2026-07-04)

---

## 0. 动机

当前系统有两种秘密注入路径，互相独立：

| 路径 | 机制 | 问题 |
|---|---|---|
| `SecretMountConfig` (内联) | PodSpec → ECI `ConfigFileVolume.Payload` / Podman tmpfs | 密钥数据出现在 Create API 请求中，明文传输 |
| `ContainerSecret` (密码本) | KV 存储加密值，CRUD 管理 | 从未被 Pod 引用过，两端割裂 |
| S3 JWT token | `SandboxService.provision()` 现场签发 → SecretMountConfig 内联 | 动态 secret，不适用 ContainerSecret |

目标：统一为**一个平台无关的 Secret 引用抽象**，ContainerSecret 作为唯一信源，PodSpec 只传引用名，平台 Codec 按能力选择引用模式或内联降级。

---

## 1. 架构

```
┌─ ContainerSecret (密码本) ────────────────────────────────────────┐
│                                                                    │
│  type: 'inline'      加密值在 KV, S3 JWT 等动态凭证                │
│  type: 'upload'      blob 引用                                     │
│  type: 'platformRef' 新增 — 值在平台原生 secret store               │
│                                                                    │
│  visibility: 'all' | 'private' | 'selected'   ← 作用域             │
│                                                                    │
│  platformRefs: {                     ← SecretProvisioner 写入      │
│    eci?: string;                     ← ECI 独立用户始终 undefined  │
│    k8s?: string;                     ← K8s Secret 名称             │
│    podman?: string;                  ← podman secret 名称          │
│    aws?: string;                     ← AWS Secrets Manager ARN     │
│  }                                                                 │
│                                                                    │
└────────────────────────┬───────────────────────────────────────────┘
                         │
                         ▼
┌─ SecretProvisioner (翻译层) ──────────────────────────────────────┐
│                                                                    │
│  provision(secret, platform)   → 调平台 API 创建原生 secret        │
│  deprovision(secret, platform) → 删原生 secret                     │
│  sync(all, platform)           → 定时全量对账                      │
│  resolve(name, platform)       → 查 platformRefs[platform]         │
│                                                                    │
│  平台行为:                                                         │
│    k8s    → kubectl apply / K8s API POST /api/v1/.../secrets      │
│    podman → podman secret create                                   │
│    eci    → 始终 failure → platformRefs.eci 保持 undefined         │
│    aws    → AWS Secrets Manager CreateSecret                       │
│                                                                    │
└────────────────────────┬───────────────────────────────────────────┘
                         │
                         ▼
┌─ PodSpec (统一抽象) ──────────────────────────────────────────────┐
│                                                                    │
│  spec.secretRefs: PlatformSecretRef[]    ← 引用平台原生名           │
│  spec.secretMounts: SecretMountConfig[]  ← 内联降级 (codec 自动填) │
│                                                                    │
└────────────────────────┬───────────────────────────────────────────┘
                         │
                         ▼
┌─ Codec (按平台翻译) ──────────────────────────────────────────────┐
│                                                                    │
│  encodeSecretRefs(refs, containerSecrets):                         │
│    for each ref:                                                   │
│      cs = containerSecrets.find(ref.name)                          │
│      platformName = cs.platformRefs[platform]   ← 翻译层输出       │
│                                                                    │
│      if platformName:                                              │
│        → 引用模式: Volume.N.Type=SecretVolume, SecretName=xxx      │
│      else:                                                         │
│        → 降级内联: ConfigFileVolume.Payload=decrypted(cs.value)    │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### 1.1 平台能力矩阵

| 平台 | 引用模式 (文件) | 引用模式 (env var) | 内联模式 |
|---|---|---|---|
| **K8s** | ✅ SecretVolume | ✅ SecretKeyRef | ✅ ConfigFileVolume 等价 |
| **ECI standalone** | ❌ K8s API 不可达 | ❌ SecretKeyRef 需预存 | ✅ ConfigFileVolume.Payload |
| **ECI on ACK** | ✅ SecretVolume | ✅ SecretKeyRef | ✅ |
| **Podman** | ✅ podman secret --secret | ❌ 无原生 env secret | ✅ tmpfs 内联 |
| **AWS ECS** | ❓ 待验证 | ❓ 待验证 | ✅ |

### 1.2 设计原则

1. **ContainerSecret 是唯一信源** — 名字、作用域、平台映射、加密值都在这里。
2. **PodSpec 只管引用** — 不知道密码在哪，只管"我需要 secret X 挂到 /etc/secrets/Y"。
3. **Codec 自适应** — 引用优先，降级内联。上层的 PodSpec 不需要知道平台支持什么。
4. **Provisioner 尽最大努力** — 同步失败不阻断容器创建，Codec 可降级内联。

---

## 2. 数据模型

### 2.1 ContainerSecret 扩展

**文件**: `src/features/container-secret/types.ts`

新增字段：

```typescript
/** 当 type='platformRef' 时，各平台的原生 secret 名称映射。Provisioner 写入，Codec 只读。 */
export interface PlatformSecretRefs {
  /** ECI K8s Secret 名。ECI 独立用户始终 undefined（不支持引用）。 */
  readonly eci?: string | undefined;
  /** K8s Secret name。 */
  readonly k8s?: string | undefined;
  /** Podman secret name。 */
  readonly podman?: string | undefined;
  /** AWS Secrets Manager ARN。 */
  readonly aws?: string | undefined;
}

export type ContainerSecretType = 'inline' | 'upload' | 'platformRef';

export interface ContainerSecret {
  // ... 现有字段保留
  /** 当 type='platformRef': 各平台的原生 secret 名称。 */
  readonly platformRefs?: PlatformSecretRefs | undefined;
}
```

`type='inline'` 保留——给动态凭证（S3 JWT）和小型 secret 使用。`type='platformRef'` 新增——给大型凭证（数据库密码、API key），值在平台侧管理。

### 2.2 PodSpec 扩展

**文件**: `src/core/pod/types.ts`

```typescript
/** 引用平台原生 Secret/凭据存储中的密钥对象。 */
export interface PlatformSecretRef {
  /** ContainerSecret.name — 用于查找平台映射和策略。 */
  readonly secretName: string;
  /** 容器内挂载路径。 */
  readonly mountPath: string;
  /** 要挂载的 key 列表。空 = 全部 key。 */
  readonly keys?: readonly string[] | undefined;
  /** 文件权限 (POSIX mode)，默认 0o400。 */
  readonly mode?: number | undefined;
}

// PodSpec.spec 中：
export interface PodSpec {
  readonly spec: {
    // ... 现有字段保留
    /** 引用平台原生 Secret（引用模式）。Codec 按平台能力可能降级为 secretMounts。 */
    readonly secretRefs?: readonly PlatformSecretRef[] | undefined;
    /** 内联 secret 数据（内联模式 / codec 降级产物）。 */
    readonly secretMounts?: readonly SecretMountConfig[] | undefined;
  };
}
```

`secretRefs` 和 `secretMounts` **同时存在**。Applicator/sandbox service 填 `secretRefs`。Codec 优先把 `secretRefs` 翻译成平台原生引用——不可用时降级为 `secretMounts`。

### 2.3 SandboxStorageAccess 保留

**文件**: `src/features/sandbox/types.ts`

```typescript
// 保留已实现的 SandboxStorageAccess —— 给 S3 JWT 这种动态 secret
export interface SandboxStorageAccess {
  readonly token: string;
  readonly expiresAt: string;
}
```

动态 secret 不走 ContainerSecret。SandboxService 直接生成 token → SecretMountConfig 内联。

---

## 3. SecretProvisioner

**新建**: `src/core/security/secret-provisioner.ts`

```typescript
import type { IAtomicStore } from '../store/interfaces.ts';
import type { ContainerSecret, PlatformSecretRefs } from '../../features/container-secret/types.ts';
import type { IS3Provider } from '../provider/s3.ts'; // 用于 AWS Secrets Manager

export type PlatformId = 'eci' | 'k8s' | 'podman' | 'aws';

export interface PlatformSecretBackend {
  readonly platform: PlatformId;
  /** 在平台原生 secret store 中创建/更新 secret。返回平台原生标识符。 */
  upsert(params: PlatformSecretParams): Promise<PlatformUpsertResult>;
  /** 从平台原生 secret store 中删除 secret。 */
  remove(platformRef: string): Promise<void>;
  /** 检查 secret 是否存在于平台原生 store 中。 */
  exists(platformRef: string): Promise<boolean>;
}

export interface PlatformSecretParams {
  readonly name: string;
  readonly data: Record<string, string>;
  readonly labels?: Record<string, string> | undefined;
}

export interface PlatformUpsertResult {
  readonly platformRef: string;
  readonly ok: boolean;
  readonly error?: string | undefined;
}

export class SecretProvisioner {
  constructor(
    private readonly backends: readonly PlatformSecretBackend[],
    private readonly atomic: IAtomicStore,
  ) {}

  /** 同步单个 ContainerSecret 到所有注册的平台 */
  async provision(secret: ContainerSecret): Promise<PlatformSecretRefs>;
  /** 从所有平台删除 */
  async deprovision(secret: ContainerSecret): Promise<void>;
  /** 全量对账 (event-loop tick 调用) */
  async syncAll(): Promise<void>;
  /** 按名字查平台引用 */
  resolve(secretName: string, platform: PlatformId): Promise<string | undefined>;
}
```

### 3.1 平台 Backend 实现

| Backend | 实现方式 | 状态 |
|---|---|---|
| `EciSecretBackend` | 始终返回 `{ ok: false }` — ECI 独立用户无 K8s API 访问 | 占位 |
| `K8sSecretBackend` | K8s API `POST /api/v1/namespaces/{ns}/secrets` | 后续 |
| `PodmanSecretBackend` | `POST /libpod/secrets/create` (已有代码) | 后续 |
| `AwsSecretBackend` | AWS SDK `SecretsManager.CreateSecret` | 后续 |

### 3.2 为什么 ECI Backend 是"占位"而非"不存在"

即使 ECI 独立用户不能创建 Secret，Backend 接口仍然注册它——`upsert()` 返回 `{ ok: false }`。这样 Codec 可以统一查 `platformRefs.eci`——`undefined` 表示不可用，触发内联降级。未来如果 ECI 放开 K8s API，只需替换 Backend 实现。

---

## 4. Codec 改造

### 4.1 ECI Codec

**文件**: `src/providers/alibaba/eci-codec.ts`

新增 `encodeSecretRefs()` 函数，在 `buildCreateParams()` 的 volume 编码段之后调用：

```typescript
function encodeSecretRefs(
  refs: readonly PlatformSecretRef[] | undefined,
  containerSecrets: Map<string, ContainerSecret>,
): { volumeParams: Record<string, string>; inlineMounts: SecretMountConfig[] } {
  const volumeParams: Record<string, string> = {};
  const inlineMounts: SecretMountConfig[] = [];

  refs?.forEach((ref, i) => {
    const cs = containerSecrets.get(ref.secretName);
    const platformName = cs?.platformRefs?.eci;

    if (platformName) {
      // 引用模式 — ECI on ACK
      const vi = i + 1;
      volumeParams[`Volume.${vi}.Name`] = `secret-${ref.secretName}`;
      volumeParams[`Volume.${vi}.Type`] = 'SecretVolume';
      volumeParams[`Volume.${vi}.SecretVolume.SecretName`] = platformName;
      // Items
      (ref.keys ?? []).forEach((key, j) => {
        volumeParams[`Volume.${vi}.SecretVolume.Items.${j + 1}.Key`] = key;
        volumeParams[`Volume.${vi}.SecretVolume.Items.${j + 1}.Path`] = key;
      });
    } else {
      // 降级内联 — ECI standalone
      const data = cs?.value ? decrypt(cs.value) : '';
      inlineMounts.push({
        mountPath: ref.mountPath,
        data,
        mode: ref.mode ?? 0o400,
      });
    }
  });

  return { volumeParams, inlineMounts };
}
```

内联 mounts 走现有 `ConfigFileVolume` 编码路径（已实现）。

### 4.2 Podman Codec

**文件**: `src/providers/podman/podman-provider.ts`

引用模式走 `podman secret create` + `--secret`（已有内核，需提取为 Backend）。

### 4.3 K8s Codec

**文件**: (后续新建)

原生 K8s Secret volume——直接映射 `secretRefs` → `spec.volumes[].secret.secretName`。

---

## 5. Applicator 改造

**文件**: `src/features/template/applicator.ts`

### 5.1 `mapStorage()` 新增 secret 解析

当 `TemplateStorage` 声明了 `secretRefs`（引用 ContainerSecret），applicator 查 ContainerSecret → 验证 visibility 作用域 → 验证状态 Active → 收集到 `PodSpec.secretRefs`。

```typescript
// mapStorage 处理 secretRef:
if (s.secretRefs?.length && securityStore) {
  for (const name of s.secretRefs) {
    const cs = await securityStore.getByName(name);
    if (!cs) throw new Error(`ContainerSecret "${name}" not found`);
    if (cs.status !== 'active') throw new Error(`ContainerSecret "${name}" is ${cs.status}`);
    // Visibility check: 当前 sandbox 的 creatorId / templateId 是否在 selectedScopeIds 中
    if (cs.visibility === 'selected' && !cs.selectedScopeIds.includes(sandboxScope)) {
      throw new Error(`ContainerSecret "${name}" not visible to this sandbox`);
    }
    podSecretRefs.push({
      secretName: cs.name,
      mountPath: s.mountPath,
      keys: s.keys,
      mode: s.secretMode,
    });
  }
}
```

### 5.2 与 securityRefNames 的关系

当前 `securityRefNames` (来自 SecurityResource) 和新的 `secretRefs` (来自 ContainerSecret) 是两个独立字段：

| 字段 | 来源 | 用户 |
|---|---|---|
| `securityRefNames` | `SecurityResource.name` | S3 JWT token → SecretMountConfig 内联 |
| `secretRefs` | `ContainerSecret.name` | 数据库密码等 → Codec 引用或内联 |

两者互不干扰。

---

## 6. Template API 扩展

**文件**: `src/features/template/types.ts`

```typescript
export interface TemplateStorage {
  // ... 现有字段

  /** @deprecated 使用 secretRefs 替代 */
  readonly securityRef?: string | undefined;
  /** 引用 SecurityResource 列表（S3 存储策略） */
  readonly securityRefs?: readonly string[] | undefined;

  /** @deprecated 使用 containerSecretRefs 替代 */
  readonly secretRef?: string | undefined;
  /** 引用 ContainerSecret 列表（平台密钥注入） */
  readonly containerSecretRefs?: readonly ContainerSecretBinding[] | undefined;
}

export interface ContainerSecretBinding {
  /** ContainerSecret.name */
  readonly name: string;
  /** 要挂载的 key。空 = 全部。 */
  readonly keys?: readonly string[] | undefined;
}
```

---

## 7. 实现顺序

### Phase 1 — 类型层 (无运行时依赖)

1. `ContainerSecretType` 加 `'platformRef'`
2. `PlatformSecretRefs` 接口
3. `ContainerSecret.platformRefs` 可选字段
4. `PodSpec.secretRefs` 新增 `PlatformSecretRef[]`
5. `TemplateStorage.containerSecretRefs` 新增

### Phase 2 — Provisioner 骨架

1. `SecretProvisioner` 类 + `PlatformSecretBackend` 接口
2. `EciSecretBackend` 占位 (always `{ ok: false }`)
3. `SecretProvisioner.resolve()` — 查 ContainerSecret.platformRefs

### Phase 3 — Codec 改造

1. ECI codec: `encodeSecretRefs()` — 引用优先 / 降级 ConfigFileVolume
2. Podman codec: 提取 `podman secret create` 到 Backend

### Phase 4 — Applicator

1. `mapStorage()` 新增 `containerSecretRefs` 解析
2. Visibility 作用域检查

### Phase 5 — API

1. `POST /api/container-secrets` —— `type='platformRef'` 支持
2. `POST /api/container-secrets/{name}/sync` —— 手动触发 provisioner 同步

### Phase 6 — 后续平台

1. `K8sSecretBackend`
2. `AwsSecretBackend`

---

## 8. 与 S3 JWT 的关系

S3 JWT token 路径不改。它不属于这个抽象：

```
S3 JWT token:
  SandboxService.provision() → SecurityResourceService.issueToken()
    → SecretMountConfig { mountPath: "/run/secrets/s3/token", data: <jwt> }
    → 直接内联，不走 ContainerSecret / Provisioner

平台密钥:
  Template → applicator → ContainerSecret CRUD → SecretProvisioner
    → PodSpec.secretRefs → Codec → SecretVolume 引用 / 降级内联
```

两条路径平行并存，互不干扰。S3 JWT 不需要 ContainerSecret 的 visibility 作用域和跨平台同步——它是一次性的、sandbox 绑定的。

---

## 9. 已知局限

| 局限 | 平台 | 影响 |
|---|---|---|
| ECI standalone 不支持 Secret 引用 | ECI | 始终走 ConfigFileVolume 内联 —— secret 数据在 Create API 请求中明文 |
| SecretProvisioner 同步延迟 | 全部 | Provisioner 和 Sandbox 创建之间有时间窗口——如果秘密刚刚更新，容器可能拿到旧值 |
| 批量创建时 Provisioner 瓶颈 | 全部 | 如果 1000 个 sandbox 同时创建且都引用同一个新 secret，Provisioner 可能成为瓶颈 |
| Kubernetes Secret 有 1Mi 大小上限 | K8s | 超大 secret 需要拆分或降级 |
| 跨平台 secret 名可能碰撞 | 全部 | 不同平台可能对 secret 名有不同的合法字符集 |

---

## 10. 废弃 / 保留

| 机制 | 状态 |
|---|---|
| `autoGenerateKeys` (V1) | 已删除 |
| `BucketKeyBinding` (V1) | 已删除 |
| `PresignedUrlSet` (V2) | 已删除 |
| `SecurityResourceRef` (V2) | 已删除 |
| `security-refresh.ts` (V2) | 已删除 |
| `SecretMountConfig` (当前) | 保留 —— 内联降级 + 动态 secret |
| `SecurityResourceService.issueToken()` (V3) | 保留 —— S3 JWT |
| `securityRefNames` (V3) | 保留 —— S3 存储策略 |

---

## 11. TODO

### 11.1 `encodeSecretRefs` — secrets Map 管线 (P1)

`encodeSecretRefs(refs, params, volumeBase, secrets?)` 的 `secrets` 参数用于内联降级时提供解密后的 Secret 明文。当前两个调用点都未传 `secrets`：

| 调用点 | 位置 | 状态 |
|---|---|---|
| `buildCreateParams` | `eci-codec.ts:700` | `secrets` 未传 → 内联降级写入空 Payload |
| `buildPodCreateParams` | `eci-codec.ts:918` | 同上 |

**影响**: 引用模式（ECI on ACK, `platformRefs.eci` 存在）不受影响。ECI standalone 的降级内联无法注入实际 Secret 值。

**修法**: 从 applicator → `CreateSandboxInput.podSecretRefs` → `PodSpec.spec.secretRefs` → `CreateContainerGroupInput.secretRefs` 的管线中，附带一个 `Map<secretName, { value: plaintext, platformRefs }>`。`buildCreateParams` / `buildPodCreateParams` 调用 `encodeSecretRefs` 时传入这个 Map。

### 11.2 `parseVolumes` — SecretVolume 解析 (P2)

`eci-codec.ts:582` 的 `parseVolumes()` 只处理 NFS 和 EmptyDir。需补充 SecretVolume 和 ConfigMapVolume 的出站解析。

### 11.3 `ECI_VS_K8S_POD_COMPARISON.md:73` — SPEC 勘误 (P3)

```
- | **ConfigMap / Secret (volume)** | 配置文件挂载 | ECI Volume 支持 NFS，但不支持 ConfigMap/Secret 卷类型 |
+ | **ConfigMap / Secret (volume)** | 配置文件挂载 | ECI 支持 ConfigMapVolume 和 SecretVolume（经 2026-07-04 API 实测验证，CreateContainerGroup 接受） |
```

### 11.4 Podman / K8s Codec (P4)

- `Podman Backend`: 从 `podman-provider.ts` 提取 `podman secret create` 逻辑到 `SecretProvisioner`
- `K8s Backend`: 新建 `K8sSecretBackend implements PlatformSecretBackend`

### 11.5 SecretProvisioner 注册到 app.ts (P5)

`app.ts` 中创建 `SecretProvisioner` 实例、注册 `EciSecretBackend`、加入 event-loop tick。
