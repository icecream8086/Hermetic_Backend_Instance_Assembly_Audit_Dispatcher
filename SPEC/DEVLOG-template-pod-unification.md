# 模板系统 → Pod 统一执行步骤

> **日期**: 2026-07-04
> **基线**: PodService 已用 transitionPod，Sandbox 仍存活但 100% 透传 Pod
> **目标**: 模板 apply 直达 PodService，删除 Sandbox，Pod 独立路由
> **总览**: 13 步，~400 行删除，~200 行新增

---

## 前置条件

- [ ] `npm run typecheck` 当前通过
- [ ] 已理解 Sandbox(11态) → Pod(5态) 的当前关系
- [ ] 已阅读 `SPEC/DEVLOG-pod-unification.md`（历史背景）

---

## Step 1 — 修正 handler.ts 的 PodSpec import

> **文件**: `src/features/template/handler.ts:22`
> **影响**: 类型标注准确性

### 改法

```diff
- import type { PodSpec } from '../../core/pod/types.ts';
+ import type { PodSpec } from '../sandbox/assembly/types.ts';
```

**原因**: `fromGeneratedTemplate()` 中 `z.custom<PodSpec>()` 解析的是 generated template 的 `podSpec` 字段。实际数据形状是 assembly PodSpec（`services` 记录），不是 core PodSpec（`spec.containers[]`）。`z.custom` 不做运行时校验所以碰巧能跑，但类型标注在撒谎。

### 验证

```bash
npm run typecheck
```

---

## Step 2 — 修正 `prod-stack` 模板的 kind

> **文件**: YAML 源文件 + `src/features/template/templates.generated.ts:759`
> **影响**: 语义正确性

### 改法

1. 找到 `prod-stack` 的 YAML 源文件（`src/features/template/templates/` 下）
2. 修改 `kind: 'ContainerGroup'` → `kind: 'Container'`
3. 运行 `npm run generate` 重新生成 `templates.generated.ts`
4. 确认生成文件中 `prod-stack` 的 kind 变为 `Container`

**原因**: `prod-stack` 没有 `podSpec` 字段，用的是 v1 的 `containers` 数组格式。`kind: 'ContainerGroup'` 语义错误。

### 验证

```bash
npm run generate
npm run typecheck
```

---

## Step 3 — `fromGeneratedTemplate` 加 kind/podSpec 一致性断言

> **文件**: `src/features/template/handler.ts`，`fromGeneratedTemplate` 函数
> **影响**: 编译期阻止无效模板

### 改法

在 `fromGeneratedTemplate` 函数中，`return` 语句之前加：

```typescript
if (kind === 'ContainerGroup' && !podSpec) {
  throw new Error(`Template "${def.id}" has kind=ContainerGroup but no podSpec`);
}
```

### 验证

```bash
npm run typecheck
```

---

## Step 4 — 新建 `assembly-to-core.ts`：Assembly PodSpec → core PodSpec

> **文件**: `src/features/template/assembly-to-core.ts`（新文件）
> **影响**: 替换 `podSpecToSandboxInput`，成为 v2 模板的唯一转换路径

### 改法

新建文件，导出纯函数：

```typescript
import type { PodSpec as AssemblyPodSpec, ServiceDefinition } from '../sandbox/assembly/types.ts';
import type { PodSpec, ContainerSpec, VolumeSpec, PlatformSecretRef, ResolvedSecretsMap } from '../../core/pod/types.ts';
import type { VolumeMountConfig } from '../../core/provider/types.ts';

export function assemblyToCorePodSpec(assembly: AssemblyPodSpec): PodSpec {
  const names = Object.keys(assembly.services);
  
  const containers: ContainerSpec[] = names.map(name => {
    const svc = assembly.services[name]!;
    const cmd = normalizeCommand(svc.command);
    const env = svc.environment
      ? Object.entries(svc.environment).map(([k, v]) => ({ name: k, value: v }))
      : undefined;
    const cpu = svc.resources?.cpu ? parseFloat(svc.resources.cpu) : 1;
    const memory = svc.resources?.memory ? parseMemoryString(svc.resources.memory) : 2048;

    return {
      name: `${assembly.name}-${name}`,
      image: svc.image,
      ...(cmd.command ? { command: cmd.command } : {}),
      ...(cmd.args ? { args: cmd.args } : {}),
      ...(env ? { env } : {}),
      ...(svc.ports ? { ports: svc.ports.map(p => ({ containerPort: p.containerPort, ...(p.protocol ? { protocol: p.protocol } : {}) })) } : {}),
      resources: { limits: { cpu, memory } },
    };
  });

  const volumes = mapServiceVolumes(assembly.services, assembly.name);

  return {
    metadata: {
      name: assembly.name,
      ...(assembly.labels ? { labels: assembly.labels } : {}),
    },
    spec: {
      containers,
      restartPolicy: 'Never',
      ...(volumes.volumeSpecs.length > 0 ? { volumes: volumes.volumeSpecs } : {}),
      // 挂载分配到对应容器
      ...(volumes.volumeMounts.length > 0 ? {
        containers: containers.map((c, i) => 
          i === 0 ? { ...c, volumeMounts: volumes.volumeMounts } : c
        ),
      } : {}),
    },
    providerOverrides: {
      alibaba: {
        region: assembly.region ?? 'cn-hangzhou',
        ...(assembly.instanceId ? { instanceId: assembly.instanceId } : {}),
      },
    },
  };
}
```

**关键**: `mapServiceVolumes()` 处理 `services.[].volumes: [{ source, destination }]`，产出 `{ volumeSpecs: VolumeSpec[], volumeMounts: VolumeMountConfig[] }`。

### 验证

```bash
npm run typecheck
```

---

## Step 5 — 消灭 Sandbox：模板 apply 直达 PodService

> **文件**: `src/features/template/handler.ts`
> **依赖**: Step 1 + Step 4
> **影响**: 核心创建路径

### 5a. 修改 POST /:id/apply 的 V1 路径（行 756-798）

```typescript
// 旧:
const applied = await applyTemplate(resolved, body.name, body.region, async (volumeId) => {
  const volEntry = await atomic.get<Record<string, unknown>>('volume:' + volumeId);
  return volEntry?.value ?? null;
});
const baseInput = applyResultToSandboxInput(applied, body.region);
const input = resolvedInstanceId
  ? { ...baseInput, instanceId: createInstanceId(resolvedInstanceId) }
  : baseInput;
const sandbox = await svc.provision(
  user?.id ? { ...input, creatorId: user.id } : input,
);
c.var.audit.write({ ... eventType: 'template.applied' ... });
return c.json(ok(sandbox), 201);

// 新:
const applied = await applyTemplate(resolved, body.name, body.region, async (volumeId) => {
  const volEntry = await atomic.get<Record<string, unknown>>('volume:' + volumeId);
  return volEntry?.value ?? null;
});
const pod = await podSvc.provision(applied.podSpec, {
  creatorId: user?.id,
  templateRef: resolved.id,
});
c.var.audit.write({
  level: KernLevel.NOTICE,
  facility: 'template',
  message: `Template applied — ${resolved.name} → pod ${pod.podId}`,
  metadata: { eventType: 'template.applied', templateId: resolved.id, podId: pod.podId, actorId: user?.id },
});
return c.json(ok(pod), 201);
```

### 5b. 修改 POST /:id/apply 的 V2 路径（行 719-753）

```typescript
// 旧:
const baseInput = podSpecToSandboxInput(resolved.podSpec);
const input = { ...baseInput, apiVersion: 'hbi-aad/v2', templateRef: resolved.id, ... };
const sandbox = await svc.provision(finalInput);
c.var.audit.write({ ... eventType: 'template.applied.v2' ... });
return c.json(ok(sandbox), 201);

// 新:
const coreSpec = assemblyToCorePodSpec(resolved.podSpec);
const pod = await podSvc.provision(coreSpec, {
  creatorId: user?.id,
  templateRef: resolved.id,
});
c.var.audit.write({
  level: KernLevel.NOTICE,
  facility: 'template',
  message: `Template applied (v2) — ${resolved.name} → pod ${pod.podId}`,
  metadata: { eventType: 'template.applied.v2', templateId: resolved.id, podId: pod.podId, actorId: user?.id },
});
return c.json(ok(pod), 201);
```

### 5c. 删除 `applyResultToSandboxInput` 函数（行 196-260）

### 5d. 删除 handler.ts 中不再需要的 import

- `import { podSpecToSandboxInput } from '../sandbox/sandbox.service.ts'`
- `import { SandboxService } from '../sandbox/sandbox.service.ts'`（如仅用于创建 sandbox）
- `import type { CreateSandboxInput } from '../sandbox/types.ts'`

新增 import：
- `import { assemblyToCorePodSpec } from './assembly-to-core.ts'`

### 验证

```bash
npm run typecheck
```

---

## Step 6 — 删除 Sandbox 实体和 SandboxService

> **依赖**: Step 5
> **影响**: 大量文件删除

### 6a. 删除文件

| 文件 | 原因 |
|---|---|
| `src/features/sandbox/sandbox.service.ts` | SandboxService 整个删除 |
| `src/features/sandbox/sandbox-store.ts` | SandboxStore 整个删除 |
| `src/features/sandbox/interfaces.ts` | ISandboxService 整个删除 |

### 6b. 清理 `src/features/sandbox/handler.ts`

删除所有 Sandbox API 路由（行 181-274）：`GET /`、`GET /:id`、`POST /:id/stop`、`POST /:id/start`、`DELETE /:id`、`POST /:id/sync`、`GET /:id/health`、`POST /:id/restart`、`PATCH /:id`。

只保留 `POST /pod`、`GET /pod`、`GET /pod/:id` 等 Pod API 路由。

删除 `ISandboxService` 参数和相关 import，保留 `PodService` 参数。

### 6c. 清理 `src/features/sandbox/index.ts`

删除 SandboxService 构造、SandboxStore、Sandbox 相关 import。只保留 PodService 构造和 Pod 路由挂载。

### 6d. 清理 `src/features/sandbox/types.ts`

删除 `Sandbox`、`SandboxStatus`、`CreateSandboxInput`、`SandboxId`、`isValidTransition`、`VALID_TRANSITIONS` 等 Sandbox 专属类型。

保留仍被引用的：`Volume`、`VolumeType`、`VolumeStatus`、`ContainerConfig`、`ContainerRuntime`、`ContainerEvent`、`NetworkInfo` 等。

### 6e. 清理 `src/features/template/handler.ts`

删除不再需要的 Sandbox 相关 import 和实例化代码。`PodService` 在 apply handler 开头统一创建一次。

### 6f. 清理 `src/features/template/index.ts`

删除 `SandboxService` 构造逻辑，改为构造 `PodService`。`createRouter` 不再需要创建 SandboxService。

### 验证

```bash
npm run typecheck
# 预期错误: 其他文件引用 SandboxService/Sandbox 的地方
# 逐个修复或删除这些引用
```

---

## Step 7 — Pod API 独立路由

> **依赖**: Step 6
> **影响**: 新增 feature 目录

### 7a. 新建 `src/features/pod/`

```
src/features/pod/
  index.ts      — createRouter(deps) → Hono
  handler.ts    — 从 sandbox/handler.ts 迁移 /pod/* 路由
```

`handler.ts` 导出 `createPodRouter(podService, permissionChecker)`。

`index.ts` 导出 `createRouter(deps)`，内部构造 PodService 并调用 `createPodRouter`。

### 7b. 从 `sandbox/handler.ts` 删除 Pod 路由

删除 `POST /pod`、`GET /pod`、`GET /pod/:id`、`POST /pod/:id/stop`、`DELETE /pod/:id`、`POST /pod/:id/sync`、`POST /pod/:id/start`、`POST /pod/:id/restart`、`GET /pod/:id/health`、`GET /pod/:id/logs`、`POST /pod/:id/exec`、`PATCH /pod/:id` 全部 12 个路由。

如果 `sandbox/` 下不再有任何路由，整个 handler.ts 删除。`sandbox/index.ts` 也删除。

### 7c. 注册到 `generated.ts`

运行 `npm run generate`，自动将新 feature 写入 `generated.ts`。预期多出：

```typescript
{ path: '/api/pods', mount: (deps) => podRouter(deps) },
```

### 7d. 新增 `POST /api/pods` — 模板 apply

在 `pod/handler.ts` 中新增：

```
POST /api/pods
Body: { templateId: string, parameters?: { provider?, region?, name? } }
→ DAG 解析 → PodSpec 组装 → PodService.provision() → PodEntity
```

这是模板 apply 的 Pod-native 入口，返回 PodEntity 而非 Sandbox。

### 验证

```bash
npm run generate
npm run typecheck
```

---

## Step 8 — 删除 `podSpecToGroupInput` + 清理 PodService

> **依赖**: Step 6
> **影响**: `src/core/pod/service.ts`

### 8a. 确认无调用点

```bash
grep -rn "podSpecToGroupInput" src/
```

### 8b. 删除函数体

删除 `podSpecToGroupInput` 函数定义。

### 8c. 删除 `src/features/sandbox/sandbox.service.ts` 中的 `podSpecToSandboxInput`

Step 6a 已删整个文件，此处确认无残留。

### 验证

```bash
npm run typecheck
```

---

## Step 9 — 补齐 `buildPodCreateParams` 的 ECI 字段

> **文件**: `src/providers/alibaba/eci-codec.ts`
> **依赖**: 无（独立修改）
> **影响**: PodSpec → ECI API 映射完整性

### 改法

将当前靠 `applyExtensionOverrides` 透传的字段显式映射：

```typescript
// 在 buildPodCreateParams 中 network 段:
const aliOverride = (spec.providerOverrides?.alibaba ?? {}) as Record<string, unknown>;

p.SecurityGroupId = String(aliOverride.securityGroupId ?? '');
if (aliOverride.vSwitchId) {
  p.VSwitchId = String(aliOverride.vSwitchId);
}
if (Array.isArray(aliOverride.subnetIds) && aliOverride.subnetIds.length > 0) {
  p.VSwitchId = (aliOverride.subnetIds as string[]).join(',');
  p.ScheduleStrategy = 'VSwitchRandom';
  delete p.ZoneId;
}
p.AutoCreateEip = String(aliOverride.autoCreateEip ?? false);
p.AutoMatchImageCache = 'true';

// Spot 策略
if (aliOverride.spotStrategy) p.SpotStrategy = String(aliOverride.spotStrategy);
if (aliOverride.spotPriceLimit !== undefined) p.SpotPriceLimit = Number(aliOverride.spotPriceLimit);

// 透传
if (aliOverride.ramRoleName) p.RamRoleName = String(aliOverride.ramRoleName);
if (aliOverride.resourceGroupId) p.ResourceGroupId = String(aliOverride.resourceGroupId);
if (aliOverride.activeDeadlineSeconds !== undefined) p.ActiveDeadlineSeconds = Number(aliOverride.activeDeadlineSeconds);
```

### 验证

```bash
npm run typecheck
```

### 已知遗留：`buildCreateParams` 与 `buildPodCreateParams` 分叉

**日期**: 2026-07-05 审计发现

两个 codec 函数对同一组 provider override 字段的覆盖不一致：

| 字段 | `buildPodCreateParams` | `buildCreateParams` |
|---|---|---|
| AutoCreateEip | ✅ 显式映射 | ❌ 仅靠 `applyExtensionOverrides` 透传 |
| SpotStrategy/PriceLimit | ✅ 显式映射 | ❌ 仅靠透传 |
| RamRoleName | ✅ 显式映射 | ❌ 仅靠透传 |
| ResourceGroupId | ✅ 显式映射 | ❌ 仅靠透传 |
| ActiveDeadlineSeconds | ✅ 显式映射 | ❌ 仅靠透传 |
| InitContainers | ✅ | ❌ |
| DNS/HostAliases | ✅ | ❌ |
| SecurityGroupId/VSwitchId 来源 | 仅 `providerOverrides.alibaba` | 合并 `input.network` + `providerOverrides.alibaba` |
| VSwitchId vs subnetIds 优先级 | subnetIds **覆盖** vSwitchId | vSwitchId **优先于** subnetIds |

此外，以下代码块在两个函数中完全重复，应提取共享 helper：
- 容器编码循环（~35 行）
- Secret mounts（~10 行）
- Volumes 编码（~10 行）
- Extension overrides 透传（~10 行）
- Tags 编码（~8 行）

**目标**: `PodService.provision()` 改为直接调 `buildPodCreateParams` 产出 `Record<string,string>`，然后传给 `provider.create()`。届时可删除 `buildCreateParams` 和 `CreateContainerGroupInput` 类型。这依赖 `IContainerProvider.create()` 接口改造——从接收 `CreateContainerGroupInput` 改为接收 `Record<string,string>`。

参见 `SPEC/ECI_CODEC_REFACTOR_PLAN.md` 原始设计意图。

---

## Step 10 — Pod GC 注册到 event-loop

> **文件**: `src/core/app.ts`
> **依赖**: PodService.gcCleanup 存在
> **影响**: Pod 生命周期自动回收

### 改法

```typescript
// 在 app.ts event-loop 注册区域:
eventBus.on('pod:gc', async () => {
  try {
    const ids = await podStore.getAllIds();
    for (const id of ids) {
      await podService.gcCleanup(createPodId(id)).catch(e => {
        console.debug(`[pod-gc] cleanup failed for ${id}: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
  } finally {
    eventLoop.enqueuePriority({ type: 'pod:gc', payload: {} });
  }
});
eventLoop.enqueuePriority({ type: 'pod:gc', payload: {} });
```

### 验证

```bash
npm run typecheck
# 运行时: 确认 wrangler dev 日志有周期性 pod:gc 事件
```

---

## Step 11 — 死代码清理

> **依赖**: Step 6 + Step 7 + Step 8
> **影响**: 删除无用代码

### 执行

```bash
npm run map
```

根据死代码扫描结果逐项删除。已知候选：

| 删除项 | 文件 | 原因 |
|---|---|---|
| `sandboxStatusToPodPhase()` | `core/pod/types.ts` | 无调用点后删除，或标 `@deprecated` |
| `CreateContainerGroupInput` | `core/provider/types.ts` | Codec 完全接管后删除 |
| `SandboxService` 残留引用 | 各文件 | Step 6 后残留 |
| `ISandboxService` 残留引用 | 各文件 | Step 6 后残留 |
| `sandbox:` 前缀 key 索引 | 各 store | Sandbox 实体已删除 |
| `SandboxStatus` enum 残留引用 | 各文件 | 改用 PodPhase |

### 验证

```bash
npm run map     # 确认无死代码
npm run typecheck
npm run lint
```

---

## Step 12 — assembly 类型搬家

> **依赖**: Step 6（sandbox 目录清空）
> **影响**: `src/features/template/types.ts`

### 改法

如果 `src/features/sandbox/assembly/` 目录仅在 Step 6 后仍存在且只被 template 引用，将其整个搬到 `src/features/template/assembly/`。

更新 `template/types.ts:4` 的 import：
```typescript
import type { PodSpec } from './assembly/types.ts';
```

如果 assembly 目录已在 Step 6 中被删除，则 `PodSpec` 类型定义已在 `template/types.ts` 自身或新建的 `template/assembly-types.ts` 中。

### 验证

```bash
npm run typecheck
```

---

## Step 13 — 全量验证

```bash
npm run typecheck   # 必须零错误
npm run lint        # 必须零错误
npm test            # 全部通过
npm run map         # 确认无死代码、无循环依赖
```

---

## 依赖图

```
Step 1 (修正 import) ─────────────────────────┐
                                              │
Step 2 (修正 prod-stack kind) ──┐              │
Step 3 (kind/podSpec 断言) ────┤  可并行       │
Step 4 (assembly→core 转换) ───┘              │
  │                                           │
Step 5 (消灭 Sandbox 创建路径) ◄── 依赖 1+4    │
  │                                           │
Step 6 (删除 Sandbox 实体) ◄────── 依赖 5      │
  │                                           │
Step 7 (Pod 独立路由) ◄─────────── 依赖 6      │
  │                                           │
Step 8 (删 podSpecToGroupInput) ◄ 依赖 6      │
  │                                           │
Step 9 (补齐 buildPodCreateParams) ◄ 独立     │
  │                                           │
Step 10 (GC event-loop) ◄────────── 独立       │
  │                                           │
Step 11 (死代码清理) ◄────────── 依赖 6+7+8    │
  │                                           │
Step 12 (assembly 搬家) ◄─────── 依赖 6        │
  │                                           │
Step 13 (验证) ◄──────────────── 全部          │
  │                                           │
Step 14 (Codec 收敛) ◄──────────── 依赖 9      │
  │                                           │
Step 15 (CEA 合规) ◄────────────── 独立        │
```

- Step 2、3、4 可与 Step 1 并行
- Step 9、10、15 不阻塞任何步骤，可随时插入
- Step 14 依赖 Step 9（字段映射已就位）
- Step 1-8 必须严格按顺序

---

## 预计变更量

| 类型 | 大约行数 |
|---|---|
| 新增 | ~200 行（assembly-to-core.ts, pod feature, GC） |
| 删除 | ~400 行（SandboxService, SandboxStore, 桥接函数, 死代码） |
| 修改 | ~100 行（handler.ts 路由, PodService, eci-codec） |
| Step 14 新增 | ~120 行（helper 提取, buildCreateParams 补齐） |
| Step 14 删除 | ~150 行（重复代码块删除, CreateContainerGroupInput 最终删除） |
| Step 15 新增 | ~80 行（Zod schema 定义, AlibabaOverridesSchema） |
| Step 15 删除 | ~40 行（`z.unknown`/`z.custom`/`as` 移除） |
| **合计** | **~1090 行** |

---

## Step 14 — Codec 收敛：`buildPodCreateParams` 成为唯一入口

> **文件**: `src/providers/alibaba/eci-codec.ts`
> **依赖**: Step 9 (字段已补齐)
> **目标**: 消除 `buildCreateParams` 与 `buildPodCreateParams` 的分叉

### 14a. 提取共享 helper

将两个函数中重复的代码块提取为模块级函数：

```typescript
function encodeContainers(p: Record<string, string>, containers: readonly ContainerCreateConfig[]): void
function encodeSecretMounts(p: Record<string, string>, mounts: readonly SecretMountConfig[] | undefined, offset: number): void
function encodeVolumes(p: Record<string, string>, volumes: readonly VolumeConfigInput[] | undefined): void
function encodeTags(p: Record<string, string>, entries: readonly [string, string][]): void
function applyProviderOverrides(p: Record<string, string>, overrides: Record<string, unknown> | undefined): void
```

### 14b. `buildCreateParams` 补齐缺失字段

补齐 `buildCreateParams` 中缺失的 AutoCreateEip、SpotStrategy、SpotPriceLimit、RamRoleName、ResourceGroupId、ActiveDeadlineSeconds 显式映射。统一 VSwitchId/subnetIds 优先级（与 `buildPodCreateParams` 一致：vSwitchId 优先）。

### 14c. 统一 SecurityGroupId/VSwitchId 决策逻辑

提取为共享函数：

```typescript
function resolveNetworkParams(
  p: Record<string, string>,
  network: { securityGroupId?: string; subnetIds?: string[] },
  aliOverride: Record<string, unknown>,
): void
```

### 14d. 最终态：`PodService.provision()` 走 `buildPodCreateParams`

改造 `IContainerProvider.create()` 接口，从接收 `CreateContainerGroupInput` 改为接收 `Record<string,string>`（即 codec 输出）。届时 `buildCreateParams` 和 `CreateContainerGroupInput` 类型可删除。

### 验证

```bash
npm run typecheck
npm test  # eci-codec.test.ts 已有 30 个测试用例
```

---

## Step 15 — CEA 合规：消除 `z.custom`/`z.unknown`/`as`

> **文件**: `handler.ts`, `pod/service.ts`, `eci-codec.ts`, `applicator.ts`
> **依赖**: 无
> **目标**: 外部输入 100% Zod schema 校验，provider overrides 一次 parse 收窄

### 15a. `z.unknown()` → Zod schema

`src/features/template/handler.ts`:
- `POST /` bodySchema: 7 个 `z.unknown().optional()` → 替换为 `TemplateStorage`/`HealthCheckDef`/`PodSpec` 的具体 schema
- `PUT /:id`: `z.unknown().parse(c.req.json())` → 替换为 `UpdateTemplateInputSchema`

`src/features/pod/handler.ts`:
- `POST /`: `z.custom<PodSpec>().parse()` → 替换为 `PodSpecSchema`（已有 `buildPodCreateParams` 做映射，可从 codec interface 导出）

### 15b. `z.custom<T>()` → Zod schema

| 文件 | 位置 | 改法 |
|---|---|---|
| `template/handler.ts` `fromGeneratedTemplate` | 9 处 `z.custom<T>().optional()` | generated template YAML 数据已经过生成脚本校验，保留 `z.custom` 但加 `eslint-disable-next-line -- generated template data is pre-validated at build time` |
| `template/applicator.ts` | 4 处 `z.custom` 带 typeof 守卫 | 改为完整的 `z.object()` schema |

### 15c. `as` 断言链 → Zod parse 收窄

`pod/service.ts` 和 `eci-codec.ts` 中所有 `(spec.providerOverrides?.alibaba as Record<string, unknown>)` 替换为：

```typescript
const AlibabaOverridesSchema = z.object({
  region: z.string().optional(),
  securityGroupId: z.string().optional(),
  vSwitchId: z.string().optional(),
  subnetIds: z.array(z.string()).optional(),
  autoCreateEip: z.union([z.boolean(), z.string()]).optional(),
  spotStrategy: z.string().optional(),
  spotPriceLimit: z.number().optional(),
  ramRoleName: z.string().optional(),
  resourceGroupId: z.string().optional(),
  activeDeadlineSeconds: z.number().optional(),
  instanceId: z.string().optional(),
  instanceType: z.string().optional(),
  // ... 其余透传字段
}).passthrough();

const ali = AlibabaOverridesSchema.parse(spec.providerOverrides?.alibaba ?? {});
```

一次 parse，下游所有访问都不需要 `as`。

### 验证

```bash
npm run lint    # consistent-type-assertions / no-explicit-any 归零
npm run typecheck
```
