# ECI Container Group 字段映射重构计划

## 问题

容器组字段需要穿过 **5 层手工映射**，每个 Provider 新增字段需在 10 个映射点各自补代码，TypeScript 无法检测遗漏。

### 当前映射点

**写方向（Domain → API）:**

| # | 文件 | 函数 | 漏字段 |
|---|------|------|--------|
| 1 | `sandbox.service.ts:798` | `toContainerGroupInput()` | —（最完整） |
| 2 | `sandbox.service.ts:875` | `toPartialContainerGroupInput()` | readinessProbe, startupProbe, tty, stdin, networkMode, volumeMounts, container providerOverrides |
| 3 | `pod-resolver.ts:88` | `toGroupInput()` | readinessProbe, startupProbe, volumeMounts, tty, stdin, networkMode, imagePullPolicy |
| 4 | `eci-container.ts:48` | `create()` | readinessProbe, startupProbe, tty, stdin, container networkMode |
| 5 | `eci-container.ts:216` | `update()` | readinessProbe, startupProbe, tty, stdin, OSS/ConfigMap/Secret volumes, GPU |
| 6 | `podman-group-provider.ts:99` | `createGroup()` | resources.limits, volumes, readinessProbe, startupProbe, tty, stdin |

**读方向（API → Domain）:**

| # | 文件 | 函数 | 漏字段 |
|---|------|------|--------|
| 7 | `eci-container.ts:466` | `parseContainerGroup()` | associatedResources hardcode [], volumes 只读 NFS 子类型, 容器 ports/probes/tty/stdin 不读回 |
| 8 | `runtime-mapper.ts:16` | `runtimeToNetwork()` | —（但依赖 #7 的 associatedResources 空数组，EIP 永为 undefined） |
| 9 | `runtime-mapper.ts:44` | `runtimeToContainers()` | gpu, gpuModel, container ports, container network, probes, tty, stdin |
| 10 | `runtime-mapper.ts:66` | `runtimeToEvents()` | — |

## 方案：声明式双向 Codec 表

定义单一 `Record<FieldKey, Codec>` 表，TypeScript 编译器强制每个字段必须同时提供 `encode`（write）和 `decode`（read）。

新增字段 → `FieldKey` union 多一个 key → codec 表立刻报 `missing property` → 必须补 encode+decode → create / update / parse 三步同时生效。

## 改造成本

| 操作 | 文件 | 实际 | 风险 |
|------|------|------|------|
| **新增** | `eci-codec.ts` | 833 行 | 无（新文件） |
| **改** | `eci-container.ts` create() | -150 行 → 6 行 | 低 |
| **改** | `eci-container.ts` update() | -70 行 → 5 行 | 低 |
| **改** | `eci-container.ts` parseContainerGroup() | 迁移到 codec + re-export | 低 |
| **已删** | `eci-container.ts` gpuModelFromInstanceType() | codec 内已有副本 | 无 |
| **已删** | `eci-container.ts` applyExtensionOverrides import | 由 buildCreateParams 内部调用 | 无 |
| **不改** | `sandbox.service.ts` | 0 | 领域转换独立于协议 |
| **不改** | `pod-resolver.ts` | 0 | 同上 |
| **不改** | `podman-group-provider.ts` | 0 | 独立协议（后续复用模式） |
| ✅ **已改** | `runtime-mapper.ts` | 补齐 finishedTime/exitCode | 低 |
| ✅ **新增** | `tests/providers/alibaba/eci-codec.test.ts` | 30 测试（encode + decode + parseProbe） | 无 |

实际效果：删 ~300 行手工映射（eci-container.ts 528→227），新增 833 行 codec 定义，净增 ~530 行但消除 10 个映射点的字段遗漏风险。TypeScript 编译器强制新字段必须提供 encode+decode。

## Codec 表设计

```typescript
// ── 底层类型 ──

/** 单个字段的双向转换器。T 在 encode 侧被类型检查，在 decode 侧被强制。 */
interface EciFieldCodec<T> {
  readonly eciParam: string;                       // 阿里云 RPC 参数名（扁平）
  readonly responsePath: string;                    // Describe 响应 JSON 路径
  readonly encode: (val: T) => string;
  readonly decode: (val: unknown) => T;
}

/** 带条件的 codec——只有 condition 返回 true 时才输出参数 */
interface ConditionalCodec<T> extends EciFieldCodec<T> {
  readonly condition?: (val: T) => boolean;
}

/** 嵌套结构：一个数组字段，用 index prefix 展开多条 RPC 参数 */
interface NestedFieldSpec<TItem> {
  readonly prefix: (idx: number) => string;         // e.g. i => `Container.${i + 1}`
  readonly collection: (input: CreateContainerGroupInput) => readonly TItem[];
  readonly fields: readonly ConditionalCodec<any>[];
  readonly nested?: readonly NestedFieldSpec<any>[]; // 子嵌套（e.g. EnvironmentVar, Port, Probe）
}
```

```typescript
// ── 顶层字段 codec（必须覆盖所有 TopLevelKey） ──

type TopLevelKey = keyof Pick<CreateContainerGroupInput,
  'cpu' | 'memory' | 'gpu' | 'gpuType' | 'restartPolicy' | 'zoneId'
>;

const TOP_FIELDS: Record<TopLevelKey, EciFieldCodec<any>> = {
  cpu: {
    eciParam: 'Cpu',
    responsePath: 'Cpu',
    encode: String,
    decode: (v) => Number(v ?? 0),
  },
  memory: {
    eciParam: 'Memory',
    responsePath: 'Memory',
    encode: String,
    decode: (v) => Number(v ?? 0),
  },
  // ... 少一个 key TypeScript 立刻报错
};
```

```typescript
// ── 容器字段 spec（嵌套，每个容器遍历输出 RPC 参数） ──

const CONTAINER_SPEC: NestedFieldSpec<ContainerCreateConfig> = {
  prefix: (i) => `Container.${i + 1}`,
  collection: (input) => input.containers,
  fields: [
    { eciParam: 'Name',  responsePath: 'Name',  encode: v => v, decode: v => String(v ?? '') },
    { eciParam: 'Image', responsePath: 'Image', encode: v => v, decode: v => String(v ?? '') },
    // ...
  ],
  nested: [
    // EnvironmentVar — 每个 env var 产生 Key/Value/FieldRefFieldPath
    // Port — 每个 port 产生 Port/Protocol
    // Probe — LivenessProbe / ReadinessProbe / StartupProbe（三种 probe 共用 spec）
  ],
};
```

```typescript
// ── Volume spec（嵌套，按子类型分发） ──

const VOLUME_SPEC: NestedFieldSpec<VolumeConfigInput> = {
  prefix: (i) => `Volume.${i + 1}`,
  collection: (input) => input.volumes ?? [],
  fields: [
    { eciParam: 'Name', responsePath: 'Name', encode: v => v, decode: v => String(v ?? '') },
    { eciParam: 'Type', responsePath: 'Type', encode: v => v, decode: v => String(v ?? '') },
  ],
  nested: [
    // NFSVolume, OSSVolume, DiskVolume, ConfigMapVolume, SecretVolume 各一个子 spec
  ],
};
```

```typescript
// ── 引擎：遍历 spec 生成 RPC params ──

function buildTopParams(
  input: CreateContainerGroupInput,
  codecs: Record<string, EciFieldCodec<any>>,
): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, codec] of Object.entries(codecs)) {
    const val = (input as any)[key];
    if (val !== undefined && val !== null) {
      params[codec.eciParam] = codec.encode(val);
    }
  }
  return params;
}

function buildNestedParams<T>(
  spec: NestedFieldSpec<T>,
  input: CreateContainerGroupInput,
): Record<string, string> {
  const params: Record<string, string> = {};
  const items = spec.collection(input);
  items.forEach((item, i) => {
    const pfx = spec.prefix(i);
    for (const field of spec.fields) {
      const val = (item as any)[field.responsePath.split('.').pop()!] ?? (item as any)[field.eciParam];
      if (val !== undefined && val !== null) {
        if (field.condition && !field.condition(val)) continue;
        params[`${pfx}.${field.eciParam}`] = field.encode(val);
      }
    }
    // Recurse into nested arrays
    for (const nested of spec.nested ?? []) {
      const nestedItems = nested.collection(input); // FIX: need per-item collection
      // ...
    }
  });
  return params;
}
```

```typescript
// ── 在 eci-container.ts 中的使用 ──

async create(input: CreateContainerGroupInput): Promise<{ providerId: string }> {
  const params: Record<string, string> = {
    RegionId: input.region,
    ContainerGroupName: input.name,
    ...buildTopParams(input, TOP_FIELDS),
    ...buildNestedParams(CONTAINER_SPEC, input),
    ...buildNestedParams(VOLUME_SPEC, input),
    ...buildExtensionParams(input.providerOverrides), // 现有 applyExtensionOverrides
  };
  
  // Network 特殊处理（条件逻辑：多 subnet → ScheduleStrategy=VSwitchRandom）
  params.SecurityGroupId = input.network.securityGroupId ?? '';
  if (input.network.subnetIds?.length) {
    params.VSwitchId = input.network.subnetIds.join(',');
    params.ScheduleStrategy = 'VSwitchRandom';
    delete params.ZoneId;
  }
  
  const resp = await rpcCall(this.endpoint, ..., 'CreateContainerGroup', params);
  return { providerId: resp.ContainerGroupId };
}
```

## 解析方向（read）

同一个 codec 表的 `responsePath` + `decode` 驱动 `parseContainerGroup()`：

```typescript
function parseFromCodecs<T>(
  raw: any,
  codecs: Record<string, EciFieldCodec<any>>,
): T {
  const result: Record<string, unknown> = {};
  for (const [key, codec] of Object.entries(codecs)) {
    const rawVal = raw[codec.responsePath];
    if (rawVal !== undefined && rawVal !== null) {
      result[key] = codec.decode(rawVal);
    }
  }
  return result as T;
}
```

嵌套结构的 parse 同理——遍历 `responsePath` 前缀 + 数组索引 + 子字段 path。

## 类型安全保障点

| 保障点 | 机制 |
|--------|------|
| 新增 `CreateContainerGroupInput` 字段 | `TopLevelKey` union 自动扩展 → codec 表报 missing property |
| 新增 `ContainerCreateConfig` 字段 | `ContainerFieldKey` union 自动扩展 → container codec 报错 |
| encode 和 decode 必须配对 | 同一个 `EciFieldCodec<T>` 对象内两方法必填 |
| create 和 update 使用相同 codec | 同一个 `buildTopParams()` 调用 |
| 读写不对称 | `encode` 和 `decode` 在同一个 codec 对象内，review 即可发现 |

## 不改的部分（非目标）

- `sandbox.service.ts` 的 `toContainerGroupInput()` — 它是领域类型 → 边界类型的转换，不涉及协议细节。已在 `#1` 映射点提供了最完整的字段覆盖。
- `pod-resolver.ts` 的 `toGroupInput()` — 同上，是 `PodSpec` 到标准 input 的转换。
- `podman-group-provider.ts` — Podman 是独立协议，不在本次范围。但 codec 模式可直接复用。
- `core/provider/mapper.ts` — helper 层，无 provider 知识，保持不变。

## 实施步骤

### Step 1: 新建 `eci-codec.ts` ✅ 已完成

- 定义 `EciFieldCodec<T>` 类型（双向 param + encode + decode）
- `ScalarKeys<T>` 工具类型：从 interface 派生 scalar 字段名 union
- `TOP_SCALARS` codec 表（`Record<TopScalarKey, EciFieldCodec<any>>`）
- `CONTAINER_SCALARS` codec 表（`Record<ContainerScalarKey, EciFieldCodec<any>>`）
- `PORT_SCALARS`, `PROBE_SCALARS`, `VOLUME_SCALARS` 子表（compile-time 守卫）
- `buildCreateParams()` 引擎：遍历 codec 表 + 处理 compound 字段（GPU JSON, command/args join, env/ports/probes 嵌套, volume per-type 分发）
- `parseContainerGroup()` 迁移到 codec（含 `parseProbe`, `parseVolumes`, `parseAssociatedResources`, `parseEvents`, `parseTags`）
- 补齐 read 方向: `associatedResources` 不再 hardcode []，volumes 支持所有子类型

文件: `src/providers/alibaba/eci-codec.ts` (833 行)

### Step 2: 改 `eci-container.ts` ✅ 已完成

- `create()`: 150 行 → 6 行 `buildCreateParams(input)` 调用
- `update()`: 70 行 → 5 行 `buildCreateParams(input, { partial: true })` 调用
- `parseContainerGroup()`: 改为 `import { parseContainerGroup } from './eci-codec.ts'` + `export { parseContainerGroup }` re-export
- `gpuModelFromInstanceType()`: 移除（codec 内已有）
- `statusToAlibaba()`: 保留（`describe()` 使用）
- `applyExtensionOverrides` import: 移除（由 `buildCreateParams` 内部调用）

文件: `src/providers/alibaba/eci-container.ts` (528 → 227 行, -301 行)

### Step 3: 补 `runtime-mapper.ts` 类型守卫 ✅ 已完成

- `runtimeToContainers()` 补齐 `finishedTime`、`exitCode` 映射（从 `OciContainer.finishedAt` / `exitCode`）
- `volumeId` 从 `undefined as never` 改为 `createVolumeId('unknown')` 标准 branded type
- `readOnly` 从 `false ..(ro ? : {})` 改为 `m.options?.includes('ro') ?? false`
- 保持返回类型注解 `: ContainerRuntime[]` / `: NetworkInfo` / `: ContainerEvent[]`（已有类型安全）

### Step 4: 测试更新 ✅ 已完成

- 新增 `tests/providers/alibaba/eci-codec.test.ts` (30 个测试):
  - `buildCreateParams` encode 方向: top-level scalars, GPU JSON, container scalars/command/args/resources, env vars (Value + FieldRefFieldPath), ports, livenessProbe/readinessProbe/startupProbe, NFS/Disk volumes, multi-subnet network, tags, extension overrides, AutoMatchImageCache, partial mode
  - `parseContainerGroup` decode 方向: identity, network, containers+env+resources, associatedResources (EIP), ephemeralStorage, tags/events, GPU string→number, graceful empty handling
  - `parseProbe` 工具: HttpGet, TcpSocket, Exec, empty→undefined
- 全部 30 测试通过

## 验收标准

1. `CreateContainerGroupInput` 新增任意字段 → TypeScript 编译报错，指向 codec 表缺失
2. `create()` 和 `update()` 不再手写 `params['Container.X.Probe...']` 格式
3. 现有测试全部通过
4. 新增 probe 往返测试通过
