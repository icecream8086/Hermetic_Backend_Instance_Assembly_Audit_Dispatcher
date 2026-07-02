# EmptyDir 共享一次性目录 — 实现规范

> **Status**: 待实现
> **优先级**: P0（第一优先级）
> **作者**: LinLai
> **日期**: 2026-07-02

---

## 1. 背景与动机

### 1.1 问题

当前 HBI-AAD 的卷系统存在以下问题：

1. **EmptyDir 功能残缺** — `VolumeType.EmptyDir` 已在枚举中定义，`mapStorage()` 也有 emptyDir case，但缺少两个关键字段：`sizeLimit`（容量限制）和 `medium`（存储介质类型）。`buildVolumeCompound()` 完全没有 EmptyDir 的分支，导致 ECI 创建请求中 EmptyDir 参数无法编码。

2. **HostPath 是开发错误** — 这个项目运行在 Cloudflare Workers + 云容器实例上，根本没有"宿主机路径"的概念。HostPath 存在于类型定义、mapper、applicator 等多个位置，但从未被使用过（模板 YAML 中无任何引用）。

3. **Disk 独立类型冗余** — 阿里云 ECI 的 `DiskVolume` 可以建模为 EmptyDir 的一个 `medium` 值。Disk 的生命周期管理（`diskId`、`deleteWithInstance`）属于存储实例管理的范畴，不应在卷类型层面暴露。

### 1.2 目标

- 补全 EmptyDir 的 `sizeLimit`（必选）和 `medium`（可选，默认 `Default`）字段
- 将 `Disk` 合并为 `EmptyDirMedium.DiskBacked`，由平台层根据 medium 值决定底层走 EmptyDir 还是 DiskVolume RPC 参数
- 删除 `HostPath` 的一切痕迹
- 在 ECI codec 层实现 `EmptyDirVolume` 的编码逻辑

### 1.3 EmptyDir 语义

| 属性 | 值 |
|---|---|
| 生命周期 | 与 Pod 绑定，Pod 销毁即释放 |
| 共享范围 | 同一 Pod 内所有容器可读写 |
| 持久化 | 不持久化。平台（阿里云 ECI）自行清理 |
| 容量 | 必选 `sizeLimit`，用户显式声明 |
| 介质 | 默认系统盘、可选内存盘、可选高性能 SSD |

> **与 ECI 30GB 系统盘的关系**: ECI 每个容器默认有 30GiB 临时存储（系统盘），用于存放镜像层和容器根文件系统。EmptyDir 是在此之外独立声明的共享卷，不与系统盘共享配额。

---

## 2. 数据流全景

用户声明的 EmptyDir 穿越 6 层到达阿里云 API：

```
TemplateStorage { type: 'emptyDir', emptyDir: { sizeLimit, medium } }     ← 用户输入
  │
  ├─[1]─ mapStorage()                     applicator.ts
  │     Volume { type: EmptyDir, emptyDir: { sizeLimit, medium } }
  │
  ├─[2]─ toPodSpec()                      sandbox.service.ts
  │     VolumeSpec { type: 'EmptyDirVolume', options: { sizeLimit, medium } }
  │
  ├─[3]─ podSpecToGroupInput()            pod/service.ts
  │     VolumeConfigInput { type: 'EmptyDirVolume', options: { sizeLimit, medium } }
  │
  ├─[4]─ mapVolume()                      provider/mapper.ts
  │     透传 options（无需改动 — options 是 Record<string, unknown>）
  │
  ├─[5]─ buildVolumeCompound()            alibaba/eci-codec.ts  ★ 核心新代码
  │     Volume.N.EmptyDirVolume.Medium = "{medium}"
  │     Volume.N.EmptyDirVolume.SizeLimit = "{sizeLimit}"
  │
  └─[6]─ 阿里云 ECI API                   CreateContainerGroup
        EmptyDir 卷创建完成
```

---

## 3. 新增类型定义

### 3.1 EmptyDirMedium 枚举

在 `src/features/sandbox/types.ts` 中新增：

```typescript
/** EmptyDir 存储介质类型。对应 K8s EmptyDirVolume.Medium 字段。 */
export enum EmptyDirMedium {
  /** 默认 — 使用实例的系统盘（ECI 默认行为）。 */
  Default = '',
  /** 内存盘 — tmpfs，高性能但 Pod 重启后数据丢失。 */
  Memory = 'Memory',
  /** 高性能 SSD 云盘 backed — 对应原 DiskVolume 行为。由 provider 层决定走 EmptyDir 还是 DiskVolume RPC。 */
  DiskBacked = 'DiskBacked',
}
```

### 3.2 EmptyDirVolumeConfig

在 `src/features/sandbox/types.ts` 中新增：

```typescript
export interface EmptyDirVolumeConfig {
  /** 容量限制，必选。K8s 标准字段，支持 Ki/Mi/Gi 后缀。如 "512Mi"、"1Gi"。 */
  readonly sizeLimit: string;
  /** 存储介质类型。默认 Default（系统盘）。 */
  readonly medium?: EmptyDirMedium | undefined;
}
```

### 3.3 Volume 实体新增字段

在 `src/features/sandbox/types.ts` 的 `Volume` 接口中新增 `emptyDir?` 字段：

```typescript
export interface Volume extends BaseEntity<VolumeId, VolumeStatus> {
  readonly type: VolumeType;
  readonly instanceId: string;
  readonly credentialRef?: string;
  readonly nfs?: NFSVolumeConfig;
  readonly disk?: DiskVolumeConfig;          // 保留兼容，标记 @deprecated
  readonly secret?: SecretVolumeConfig;
  readonly configMap?: ConfigMapVolumeConfig;
  readonly oss?: OSSVolumeConfig;
  readonly emptyDir?: EmptyDirVolumeConfig;   // ← 新增
}
```

---

## 4. 逐层改动清单

### 第 1 层：`src/features/sandbox/types.ts` — 类型源头

| 操作 | 内容 |
|---|---|
| **新增** | `EmptyDirMedium` 枚举（3 个值：`Default`、`Memory`、`DiskBacked`） |
| **新增** | `EmptyDirVolumeConfig` 接口（`sizeLimit: string`、`medium?: EmptyDirMedium`） |
| **修改** | `Volume` 接口：新增 `readonly emptyDir?: EmptyDirVolumeConfig` |
| **修改** | `VolumeType` 枚举：删除 `HostPath = 'HostPathVolume'`、`Disk = 'DiskVolume'` |
| **保留** | `DiskVolumeConfig` 接口（兼容旧数据，标记 `@deprecated 使用 EmptyDirMedium.DiskBacked 替代`） |
| **保留** | `Volume` 接口的 `disk?: DiskVolumeConfig` 字段（兼容旧数据，标记 `@deprecated`） |
| **删除** | `Volume` 实体中不应再创建新的 disk 类型 Volume |

### 第 2 层：`src/features/template/types.ts` — 用户输入类型

| 操作 | 内容 |
|---|---|
| **修改** | `TemplateStorage.type` 联合：删除 `'hostPath'`、`'disk'` |
| **修改** | `TemplateStorage.emptyDir` 字段：从 `undefined` 改为 `{ sizeLimit: string; medium?: 'Default' \| 'Memory' \| 'DiskBacked' }` |
| **删除** | `TemplateStorage.hostPath` 字段 |
| **保留** | `TemplateStorage.disk` 字段（兼容旧模板，标记 `@deprecated`） |

`TemplateStorage` 改动后的 emptyDir 部分：

```typescript
export interface TemplateStorage {
  readonly name: string;
  readonly type: 'oss' | 'nfs' | 'emptyDir' | 'configMap' | 'secret';  // 删除了 hostPath、disk
  readonly mountPath: string;
  readonly instanceId: string;
  readonly volumeId?: string | undefined;
  readonly bucketId?: string | undefined;
  readonly oss?: { bucket: string; path: string; readOnly?: boolean } | undefined;
  readonly nfs?: { server: string; path: string; readOnly?: boolean } | undefined;
  // 以下为 emptyDir 的新结构
  readonly emptyDir?: {
    readonly sizeLimit: string;                                           // 必选
    readonly medium?: 'Default' | 'Memory' | 'DiskBacked' | undefined;   // 可选，默认 Default
  } | undefined;
  readonly configMap?: { name: string; env: readonly { key: string; value: string }[] } | undefined;
  readonly secret?: { name: string; items?: readonly { key: string; path: string; mode?: number }[] } | undefined;
  /** @deprecated 使用 emptyDir.medium = 'DiskBacked' 替代 */
  readonly disk?: { diskId: string; fsType?: string; sizeGiB?: number; readOnly?: boolean; deleteWithInstance?: boolean } | undefined;
  /** @deprecated 未使用，开发错误 */
  readonly hostPath?: { path: string } | undefined;
  readonly size?: number | undefined;
  readonly providerOverrides?: Record<string, unknown> | undefined;
}
```

### 第 3 层：`src/features/template/applicator.ts` — 模板装配器

文件：`src/features/template/applicator.ts:196-329`

#### 3a. 修改 `mapStorage()` 的 emptyDir case（第 278-286 行）

**现状**：
```typescript
case 'emptyDir': {
  volumes.push({
    id: vid, name: s.name, tags: [], createdAt: now, updatedAt: now,
    status: VolumeStatus.Detached, type: VolumeType.EmptyDir,
    instanceId: s.instanceId,
  });
  volumeMounts.push({ volumeId: vid, mountPath: s.mountPath, readOnly: false });
  break;
}
```

**改为**：
```typescript
case 'emptyDir': {
  if (!s.emptyDir?.sizeLimit) break;  // sizeLimit 必选，无值则跳过
  volumes.push({
    id: vid, name: s.name, tags: [], createdAt: now, updatedAt: now,
    status: VolumeStatus.Detached, type: VolumeType.EmptyDir,
    instanceId: s.instanceId,
    emptyDir: {
      sizeLimit: s.emptyDir.sizeLimit,
      ...(s.emptyDir.medium ? { medium: mapEmptyDirMedium(s.emptyDir.medium) } : {}),
    },
  });
  volumeMounts.push({ volumeId: vid, mountPath: s.mountPath, readOnly: false });
  break;
}
```

#### 3b. 修改 `mapStorage()` 的 disk case（第 297-313 行）

**现状**：创建 `VolumeType.Disk` 的 Volume 实体。

**改为**：转为 EmptyDir + DiskBacked medium 语义：

```typescript
case 'disk': {
  // 兼容旧模板：disk 转为 EmptyDir + DiskBacked
  if (!s.disk) break;
  volumes.push({
    id: vid, name: s.name, tags: [], createdAt: now, updatedAt: now,
    status: VolumeStatus.Detached, type: VolumeType.EmptyDir,
    instanceId: s.instanceId,
    emptyDir: {
      sizeLimit: s.disk.sizeGiB ? `${String(s.disk.sizeGiB)}Gi` : '50Gi',
      medium: EmptyDirMedium.DiskBacked,
    },
  });
  volumeMounts.push({ volumeId: vid, mountPath: s.mountPath, readOnly: s.disk.readOnly ?? false });
  break;
}
```

> 注意：原来 disk case 中的 `diskId`、`fsType`、`deleteWithInstance` 在 EmptyDir 语义下不再需要。云盘的具体 ID 由 provider 层根据 instanceId + volumeId 反推创建。

#### 3c. 删除 hostPath case（第 269-277 行）

完全删除 `case 'hostPath': { ... }` 分支。switch 的 `default: const _: never` 将在编译期确保无遗漏。

#### 3d. 新增 `mapEmptyDirMedium()` 辅助函数

```typescript
import { EmptyDirMedium } from '../sandbox/types.ts';

function mapEmptyDirMedium(raw: string): EmptyDirMedium {
  switch (raw) {
    case 'Memory': return EmptyDirMedium.Memory;
    case 'DiskBacked': return EmptyDirMedium.DiskBacked;
    default: return EmptyDirMedium.Default;
  }
}
```

### 第 4 层：`src/core/provider/mapper.ts` — Provider 映射层

#### 4a. 修改 `MappableVolume` 接口（第 95-101 行）

新增 `emptyDir` 字段：

```typescript
export interface MappableVolume {
  readonly id: string;
  readonly type: string;
  readonly nfs?: { readonly server: string; readonly path: string; readonly readOnly: boolean } | undefined;
  readonly disk?: { ... } | undefined;  // 保留兼容
  readonly secret?: { ... } | undefined;
  readonly emptyDir?: { readonly sizeLimit: string; readonly medium?: string | undefined } | undefined;  // ← 新增
}
```

#### 4b. 修改 `mapVolume()` 函数（第 103-117 行）

新增 emptyDir 分支：

```typescript
export function mapVolume(v: MappableVolume): VolumeConfigInput {
  let options: Record<string, unknown> | undefined;
  if (v.nfs) {
    options = { server: v.nfs.server, path: v.nfs.path, readOnly: v.nfs.readOnly };
  } else if (v.emptyDir) {
    options = { sizeLimit: v.emptyDir.sizeLimit, medium: v.emptyDir.medium ?? '' };
  } else if (v.disk) {
    // 兼容旧 disk 类型 — 转为 DiskBacked EmptyDir
    options = { sizeLimit: v.disk.sizeGiB ? `${String(v.disk.sizeGiB)}Gi` : '50Gi', medium: 'DiskBacked', diskId: v.disk.diskId, fsType: v.disk.fsType, readOnly: v.disk.readOnly };
    if (v.disk.deleteWithInstance !== undefined) options.deleteWithInstance = v.disk.deleteWithInstance;
  } else if (v.secret) {
    options = { name: v.secret.name };
    if (v.secret.items) options.items = [...v.secret.items];
  }
  return { id: v.id, type: v.type, ...(options ? { options } : {}) };
}
```

### 第 5 层：`src/core/pod/types.ts` — PodSpec 层

#### 5a. `VolumeSpec.type` 联合（第 88 行）

删除 `'HostPathVolume'` 和 `'DiskVolume'`：

```typescript
export interface VolumeSpec {
  readonly id: string;
  readonly type: 'NFSVolume' | 'EmptyDirVolume' | 'SecretVolume' | 'ConfigMapVolume' | 'OSSVolume';
  readonly options?: Record<string, unknown> | undefined;
}
```

### 第 6 层：`src/features/sandbox/sandbox.service.ts` — Sandbox 服务层

#### 6a. `toPodSpec()` 函数（第 682-721 行）

需要在 volumes 映射中传递 emptyDir 的 options。当前代码中 volumes 行被注释掉了（第 717 行）：

```typescript
// volumes: mapped via providerOverrides for now (sandbox Volume entity ≠ PodSpec VolumeSpec)
```

需要添加 volumes 映射逻辑，将 `Volume` 实体转为 `VolumeSpec`，包括 emptyDir 的 `sizeLimit` 和 `medium`。

### 第 7 层（核心新代码）：`src/providers/alibaba/eci-codec.ts` — ECI 编码器

文件：`src/providers/alibaba/eci-codec.ts:516-563`

#### 7a. 修改 `buildVolumeCompound()` — 新增 EmptyDir 分支

在函数开头（检查 `opts.server` 之前）加入 EmptyDir 判断：

```typescript
function buildVolumeCompound(v: VolumeConfigInput, pfx: string): Record<string, string> {
  const p: Record<string, string> = {};
  const opts = (v.options ?? {});

  // ── EmptyDir Volume ──
  if (v.type === 'EmptyDirVolume' || opts.sizeLimit !== undefined) {
    // ECI API: Volume.N.Type = 'EmptyDirVolume'
    //          Volume.N.EmptyDirVolume.Medium = '' | 'Memory' | 'DiskBacked'
    //          Volume.N.EmptyDirVolume.SizeLimit = '512Mi'
    p[`${pfx}.Type`] = 'EmptyDirVolume';
    const medium = strVal(opts.medium ?? '');
    if (medium) {
      p[`${pfx}.EmptyDirVolume.Medium`] = medium;
    }
    if (opts.sizeLimit !== undefined) {
      p[`${pfx}.EmptyDirVolume.SizeLimit`] = strVal(opts.sizeLimit);
    }
    // DiskBacked 特殊处理：如果 medium 是 DiskBacked，可能需要在 EmptyDir 之外
    // 额外声明 DiskVolume 参数。取决于 ECI API 是否支持 EmptyDir 直接引用云盘。
    // 如果不支持，则此处需要同时设置 DiskVolume 参数：
    if (medium === 'DiskBacked' && opts.diskId) {
      p[`${pfx}.DiskVolume.DiskId`] = strVal(opts.diskId);
      p[`${pfx}.DiskVolume.FsType`] = strVal(opts.fsType ?? 'ext4');
      if (opts.readOnly) p[`${pfx}.DiskVolume.ReadOnly`] = 'true';
    }
    return p;  // EmptyDir 不与其他卷类型混合
  }

  // ── 以下为 NFS / OSS / Disk / ConfigMap / Secret 的现有逻辑 ──
  if (opts.server) {
    // ... 现有 NFS 逻辑不变
  }
  // ... 其余现有逻辑不变
}
```

> **关键决策点**: `DiskBacked` medium 在 ECI API 层的实现方式取决于阿里云 API 文档。有两种可能：
>
> **方案 A** — ECI 支持 `EmptyDirVolume.Medium = 'DiskBacked'` 并自动创建云盘：
> 只需要设置 `EmptyDirVolume.Medium` 和 `EmptyDirVolume.SizeLimit`，无需额外 DiskVolume 参数。
>
> **方案 B** — ECI 不支持，需要手动创建 DiskVolume：
> 需要同时设置 `EmptyDirVolume` 和 `DiskVolume` 参数。DiskId 由 provider 层通过阿里云 OpenAPI 创建云盘获得。
>
> **实现前必须查阅阿里云 ECI API 文档确认。**

#### 7b. 修改 `EciVolumeItem` 接口（第 154-162 行）

新增 `EmptyDirVolume` 响应解析：

```typescript
interface EciVolumeItem {
  Name?: string;
  Type?: string;
  NFSVolume?: { Server?: string; Path?: string; ReadOnly?: boolean };
  OSSVolume?: { Bucket?: string; Path?: string; ReadOnly?: boolean; Endpoint?: string };
  DiskVolume?: { DiskId?: string; FsType?: string; DiskSize?: number; DiskCategory?: string; ReadOnly?: boolean; DeleteWithInstance?: boolean };
  EmptyDirVolume?: { Medium?: string; SizeLimit?: string };  // ← 新增
  ConfigMapVolume?: { Name?: string; Items?: { Key?: string; Path?: string; Mode?: number }[] };
  SecretVolume?: { SecretName?: string; Items?: { Key?: string; Path?: string; Mode?: number }[] };
}
```

#### 7c. 修改 `parseVolumes()` 函数（第 565-574 行）

新增 EmptyDir 解析：

```typescript
function parseVolumes(vols: EciVolumeItem[] | undefined): VolumeRuntimeInfo[] {
  if (!vols?.length) return [];
  return vols.map(v => ({
    name: v.Name ?? '',
    type: v.Type ?? '',
    ...(v.NFSVolume ? {
      nfs: { server: v.NFSVolume.Server ?? '', path: v.NFSVolume.Path ?? '', readOnly: v.NFSVolume.ReadOnly === true },
    } : {}),
    ...(v.EmptyDirVolume ? {
      emptyDir: { sizeLimit: v.EmptyDirVolume.SizeLimit ?? '', medium: v.EmptyDirVolume.Medium },
    } : {}),
  }));
}
```

---

## 5. HostPath 删除清单

需要从以下 12 个文件中删除所有 HostPath 引用：

| # | 文件 | 操作 |
|---|---|---|
| 1 | `src/features/sandbox/types.ts:123` | `VolumeType` 枚举删除 `HostPath` |
| 2 | `src/features/template/types.ts:114` | `TemplateStorage.type` 联合删除 `'hostPath'` |
| 3 | `src/features/template/types.ts:123` | 删除 `TemplateStorage.hostPath` 字段 |
| 4 | `src/features/template/applicator.ts:269-277` | 删除 `case 'hostPath'` 分支 |
| 5 | `src/core/pod/types.ts:88` | `VolumeSpec.type` 联合删除 `'HostPathVolume'` |
| 6 | `src/core/provider/mapper.ts` | 无需改动（mapper 中无 HostPath 专用逻辑） |
| 7 | `src/providers/alibaba/eci-codec.ts` | 无需改动（codec 中无 HostPath 专用逻辑） |
| 8 | `src/providers/podman/podman-provider.ts` | 确认无 hostPath 引用（经确认无） |
| 9 | `src/features/volume/types.ts` | 确认无 hostPath 引用（经确认无） |
| 10 | `src/features/volume/schema.ts` | 确认无 hostPath 引用 |
| 11 | `src/features/volume/entity-schema.ts` | 确认无 hostPath 引用 |
| 12 | `src/features/volume/response-schema.ts` | 确认无 hostPath 引用 |
| 13 | `src/features/sandbox/assembly/types.ts:27-32` | `VolumeTemplateSpec` 无需改动（无 hostPath 字段） |

---

## 6. Disk → EmptyDir 合并清单

| # | 文件 | 操作 |
|---|---|---|
| 1 | `src/features/sandbox/types.ts` | `VolumeType` 枚举删除 `Disk`；保留 `DiskVolumeConfig` 接口但标记 `@deprecated` |
| 2 | `src/features/template/types.ts` | `TemplateStorage.type` 联合删除 `'disk'`；保留 `disk` 字段但标记 `@deprecated` |
| 3 | `src/features/template/applicator.ts` | `case 'disk'` 改为创建 `EmptyDir + DiskBacked` 的 Volume |
| 4 | `src/core/pod/types.ts` | `VolumeSpec.type` 联合删除 `'DiskVolume'` |
| 5 | `src/core/provider/mapper.ts` | `mapVolume()` disk 分支改为透传 `DiskBacked` options |
| 6 | `src/providers/alibaba/eci-codec.ts` | `buildVolumeCompound()` disk 分支逻辑保留，但仅当 `medium === 'DiskBacked'` 且有 `diskId` 时触发 |
| 7 | `src/features/volume/types.ts` | `CreateVolumeInput.disk` / `UpdateVolumeInput.disk` 保留，标记 `@deprecated` |
| 8 | `src/features/sandbox/assembly/types.ts` | `VolumeTemplateSpec.disk` 保留，标记 `@deprecated` |

---

## 7. ECI API 参数参考

EmptyDir 在阿里云 ECI `CreateContainerGroup` API 中的参数格式（待通过 API 文档确认）：

```
Volume.1.Name = "shared-data"
Volume.1.Type = "EmptyDirVolume"
Volume.1.EmptyDirVolume.Medium = "Memory"        # '' | 'Memory'
Volume.1.EmptyDirVolume.SizeLimit = "512Mi"      # K8s 标准格式
```

对应的 VolumeMount（在 Container 级别）：

```
Container.1.VolumeMount.1.Name = "shared-data"
Container.1.VolumeMount.1.MountPath = "/data/share"
Container.1.VolumeMount.1.ReadOnly = "false"
```

---

## 8. 验证清单

实现完成后，按顺序验证：

1. **类型检查**: `npm run typecheck` 通过。删除 `HostPath` 后 switch 语句的 `default: const _: never` 应无编译错误。
2. **ESLint**: `npm run lint` 通过。无新增 disable 注释。
3. **单元测试**: `npm test` 全量通过。
4. **死代码扫描**: `npm run map` 确认无新增死代码。
5. **模板兼容**: 现有模板 YAML（`src/features/template/templates/`）无 hostPath/disk 引用（已确认无）。
6. **ECI 集成测试**: 用最小模板创建一个 EmptyDir 卷，确认 ECI API 调用参数正确。

### 最小验证模板

```json
{
  "name": "emptydir-test",
  "apiVersion": "hbi-aad/v1",
  "kind": "Container",
  "container": {
    "region": "cn-hangzhou",
    "containers": [
      {
        "name": "test",
        "image": "alpine:latest",
        "command": ["sleep", "3600"]
      }
    ]
  },
  "extensions": {
    "storage": [
      {
        "name": "shared-data",
        "type": "emptyDir",
        "mountPath": "/data/share",
        "instanceId": "<your-instance-id>",
        "emptyDir": {
          "sizeLimit": "512Mi",
          "medium": "Default"
        }
      }
    ]
  }
}
```

---

## 9. 不在此次范围内的后续工作

- **Podman emptyDir 特殊处理**: Podman 自带临时目录机制，暂不考虑。如后续需要，在 `podman/pod-codec.ts` 中实现 `containerToCreateBody()` 的 emptyDir → tmpfs 映射。
- **S3 自动注入 metadata**: 独立需求，后续 SPEC 覆盖。
- **NFS 保留现状**: 通过 API 外部传参挂载，代码不动。
- **ConfigMap 未决**: 暂未考虑好，保留现状。

---

## 10. 实现顺序建议

按依赖关系自底向上：

1. **类型层** — `sandbox/types.ts`、`template/types.ts`、`pod/types.ts`（新增枚举、接口，删除 HostPath/Disk）
2. **映射层** — `provider/mapper.ts`（新增 emptyDir 透传）
3. **装配层** — `applicator.ts`（改 emptyDir case、disk case，删 hostPath case）
4. **服务层** — `sandbox.service.ts`（`toPodSpec()` 补 volumes 映射）
5. **编码层** — `eci-codec.ts`（`buildVolumeCompound()` 加 EmptyDir 分支，`parseVolumes()` 加解析）
6. **清理层** — volume 相关文件删 hostPath 引用，标记 disk 为 deprecated
7. **验证** — typecheck → lint → test → map
