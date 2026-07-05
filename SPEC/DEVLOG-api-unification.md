# Pod API 与 Template Apply API 统一 — 开发步骤

> **日期**: 2026-07-05
> **基线**: PodService 已独立运行，SandboxService 已删除，Pod feature 路由已注册
> **目标**: `/api/pods` 与 `/api/templates/:id/apply` 响应格式统一、校验统一
> **总览**: 7 步，~130 行新增，~288 行删除

---

## 前置条件

- [ ] `npm run typecheck` 当前通过（361 个预存错误忽略——全是 podman/stub 的，不属于本次修复范围）
- [ ] 已理解两条创建路径的差异（见 §0）
- [ ] 已阅读 `SPEC/DEVLOG-template-pod-unification.md`（前序步骤）

---

## 0. 当前状态：两条路径的差异

### 路径 A — Direct Pod API

```
POST /api/pods
  Body: PodSpec (core/pod/types.ts)
  → pod/handler.ts:43  z.custom<PodSpec>().parse()
  → podSvc.provision(spec, { creatorId })
  → service.ts:105-181  手动构造 CreateContainerGroupInput → provider.create()
  → 返回: ok({ podId, providerId, phase, name })  ← PodCreateResponseSchema
```

### 路径 B — Template Apply API

```
POST /api/templates/:id/apply
  → resolveTemplate(atomic, id) → Template (DAG 合并)
  → 分支 1 (V2, kind=ContainerGroup + podSpec):
      assemblyToCorePodSpec(resolved.podSpec) → PodSpec
      podSvc.provision(coreSpec, { creatorId, templateRef })
      → 返回: ok(pod)  ← 完整 PodEntity, 但 schema 是 z.unknown()
  → 分支 2 (V1, kind=Container):
      applyTemplate(resolved, name, region, resolveVolume) → { podSpec, securityRefNames }
      podSvc.provision(applied.podSpec, { creatorId, templateRef })
      → 返回: ok(pod)  ← 同上, securityRefNames 静默丢失
```

### 差异清单

| 项目 | Pod API (路径 A) | Template Apply (路径 B) |
|---|---|---|
| 输入校验 | `z.custom<PodSpec>()` — 零校验 | 无 schema — body 无结构校验 |
| 响应 schema | `PodCreateResponseSchema`（5 字段） | `z.unknown()` — 无文档 |
| 返回数据 | `{ podId, providerId, phase, name }` | 完整 `PodEntity`（~15 字段） |
| codec 路径 | 手动内联构造 `CreateContainerGroupInput` | 同上（同一条 provision 代码） |
| securityRefNames | N/A | `applyTemplate` 算出但 handler 丢弃 |
| CEA 合规 | ❌ `z.custom` + `z.unknown` | ❌ 9 处 `z.custom` |
| audit eventType | `pod.provisioned` | `template.applied` / `template.applied.v2` |

---

## Step 1 — 统一响应格式：两条路径都返回 `PodCreateResponse`

> **文件**: `src/features/template/handler.ts`, `src/features/pod/response-schema.ts`
> **依赖**: 无
> **影响**: 响应体结构变更（BREAKING — 模板 apply 原来返回完整 PodEntity，现在返回摘要）

### 1a. 确认 PodCreateResponse 是标准响应

当前 `pod/response-schema.ts`:

```typescript
export const PodCreateResponseSchema = z.object({
  podId: z.string(),
  providerId: z.string().optional(),
  phase: PodPhaseSchema,
  name: z.string(),
});
```

这是创建后的最小摘要。如果要更丰富，可以加 `creatorId`、`templateRef`、`createdAt`：

```typescript
export const PodCreateResponseSchema = z.object({
  podId: z.string(),
  name: z.string(),
  phase: PodPhaseSchema,
  providerId: z.string().optional(),
  creatorId: z.string().optional(),
  templateRef: z.string().optional(),
  createdAt: z.number(),
});
```

但**此次不改** PodCreateResponseSchema 本身——先统一引用，后续再扩展。

### 1b. 修改 template handler 的响应

**文件**: `src/features/template/handler.ts`

**V2 路径**（L632-644）:

```diff
  const coreSpec = assemblyToCorePodSpec(resolved.podSpec);
  const pod = await podSvc.provision(coreSpec, {
    creatorId: user?.id,
    templateRef: resolved.id,
  });
  c.var.audit.write({ ... });
- return c.json(ok(pod), 201);
+ return c.json(ok({
+   podId: pod.podId,
+   providerId: pod.providerId,
+   phase: pod.phase,
+   name: pod.name,
+ }), 201);
```

**V1 路径**（L647-661）:

```diff
  const pod = await podSvc.provision(applied.podSpec, {
    creatorId: user?.id,
    templateRef: resolved.id,
  });
  c.var.audit.write({ ... });
- return c.json(ok(pod), 201);
+ return c.json(ok({
+   podId: pod.podId,
+   providerId: pod.providerId,
+   phase: pod.phase,
+   name: pod.name,
+ }), 201);
```

### 1c. 修改 template handler 的 OpenAPI schema

**文件**: `src/features/template/handler.ts`

导入 PodCreateResponseSchema:
```typescript
import { PodCreateResponseSchema } from '../pod/response-schema.ts';
```

修改 POST /:id/apply 的路由定义（L616）:

```diff
- responses: { 201: { description: 'Pod', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } }
+ responses: { 201: { description: 'Pod created', content: { 'application/json': { schema: OkResponse(PodCreateResponseSchema) } } } }
```

### 1d. 验证

```bash
npm run typecheck
```

预期: 无新增错误。template handler 的响应构造变为 4 字段摘要。

---

## Step 2 — 传播 `securityRefNames`：不再丢弃

> **文件**: `src/features/template/handler.ts`
> **依赖**: 无（独立修复）
> **影响**: S3 安全策略在模板 apply 时生效

### 2a. 根因

`applyTemplate()` 返回 `{ podSpec, securityRefNames }`。`securityRefNames` 是模板 storage 中引用的 SecurityResource 名称列表。这些名称需要在 provision 时由 `PodService` 传递给 `SecurityResourceService` 来签发 JWT。

当前 handler:
```typescript
const applied = await applyTemplate(resolved, body.name, body.region, ...);
const pod = await podSvc.provision(applied.podSpec, {  // ← applied.securityRefNames 未使用
  creatorId: user?.id,
  templateRef: resolved.id,
});
```

### 2b. 检查 PodService.provision 是否接受 securityRefNames

**文件**: `src/core/pod/service.ts:105`

当前签名:
```typescript
public async provision(spec: PodSpec, context?: ProvisionContext): Promise<PodEntity>
```

`ProvisionContext`:
```typescript
export interface ProvisionContext {
  readonly creatorId?: string | undefined;
  readonly templateRef?: string | undefined;
}
```

`securityRefNames` 不存在于 `ProvisionContext` 中，也不在 `PodSpec` 中。

### 2c. 决定：securityRefNames 放哪里

两个选择：
- **A**: 加入 `ProvisionContext` — 简单，但语义上 securityRefNames 是模板层概念，不应污染 core PodService
- **B**: 在 handler 层调用 SecurityResourceService 签发 JWT，将 JWT token 注入 `PodSpec.spec.secretMounts`

**选择 B**。理由：
1. securityRefNames 是模板层的概念——PodService 不应该知道 SecurityResource
2. JWT 签发后的结果是 `secretMounts`（`ConfigFileVolume` 格式），这是 PodSpec 已有的字段
3. 符合 SPEC `s3-presigned-control-plane.md` 的设计：JWT 在 sandbox provision 时签发

### 2d. 实现

**文件**: `src/features/template/handler.ts`

在 `POST /:id/apply` 的 handler 中，`applyTemplate` 之后、`podSvc.provision` 之前，加 securityRefNames 处理:

```typescript
// 在 applyTemplate 之后:
const applied = await applyTemplate(resolved, body.name, body.region, async (volumeId) => {
  const volEntry = await atomic.get<Record<string, unknown>>('volume:' + volumeId);
  return volEntry?.value ?? null;
});

// ── NEW: 将 securityRefNames 转换为 secretMounts ──
const secretMounts: import('../../core/provider/types.ts').SecretMountConfig[] = [];
if (applied.securityRefNames.length > 0 && securityService) {
  for (const name of applied.securityRefNames) {
    // V3: JWT presigned URL 由 SecurityResourceService 在 provision 时签发
    // 当前: 将 securityRefName 编码为 secretMount，由 codec 层处理
    // 注: 如果 SecurityResourceService 在 core 层不可用，此处先以 name 标记
    //    实际的 JWT 签发延迟到 codec 层（buildPodCreateParams）
  }
}

// 将 secretMounts 合并进 applied.podSpec
const finalSpec: PodSpec = secretMounts.length > 0
  ? {
      ...applied.podSpec,
      spec: {
        ...applied.podSpec.spec,
        secretMounts: [
          ...(applied.podSpec.spec.secretMounts ?? []),
          ...secretMounts,
        ],
      },
    }
  : applied.podSpec;

const pod = await podSvc.provision(finalSpec, {
  creatorId: user?.id,
  templateRef: resolved.id,
});
```

### 2e. 当前状态

`securityRefNames` 的透传依赖 codec 管线的最终方案（尚未定夺）。当前暂不修改——仅在此文档中记录数据丢失位置。

```typescript
// FIXME(api-unification): applied.securityRefNames is computed but dropped.
// Resolution depends on the codec pipeline redesign (TBD).
const applied = await applyTemplate(resolved, body.name, body.region, ...);
const pod = await podSvc.provision(applied.podSpec, {
  creatorId: user?.id,
  templateRef: resolved.id,
});
```

### 2f. 验证

```bash
npm run typecheck  # 无新增错误
```

---

## Step 3 — CEA 合规：消除 `z.custom` / `as` / `z.unknown`

> **文件**: `src/features/pod/handler.ts`, `src/features/template/handler.ts`, `src/core/pod/service.ts`
> **依赖**: 无（独立修改）
> **影响**: 外部输入 100% Zod 校验

### 3a. pod/handler.ts — `z.custom<PodSpec>()` → 真实 Schema

**文件**: `src/features/pod/handler.ts:43`

```diff
- const spec = z.custom<PodSpec>().parse(await c.req.json());
+ const spec = PodSpecSchema.parse(await c.req.json());
```

需要新建 `PodSpecSchema`。创建位置：`src/core/pod/schema.ts`（新文件）。

```typescript
// src/core/pod/schema.ts
import { z } from 'zod';

export const EnvVarSchema = z.object({
  name: z.string().min(1),
  value: z.string().optional(),
  valueFrom: z.unknown().optional(),
});

export const ContainerPortSchema = z.object({
  containerPort: z.number().int().positive(),
  hostPort: z.number().int().optional(),
  protocol: z.string().optional(),
});

export const VolumeMountSchema = z.object({
  volumeId: z.string().min(1),
  mountPath: z.string().min(1),
  readOnly: z.boolean(),
  mountPropagation: z.string().optional(),
  credentialRef: z.string().optional(),
});

export const ProbeSpecSchema = z.object({
  httpGet: z.object({
    path: z.string(),
    port: z.number(),
    scheme: z.string().optional(),
  }).optional(),
  tcpSocket: z.object({
    port: z.number(),
  }).optional(),
  exec: z.object({
    command: z.array(z.string()),
  }).optional(),
  initialDelaySeconds: z.number().optional(),
  periodSeconds: z.number().optional(),
  timeoutSeconds: z.number().optional(),
  successThreshold: z.number().optional(),
  failureThreshold: z.number().optional(),
});

export const ContainerSpecSchema = z.object({
  name: z.string().min(1),
  image: z.string().min(1),
  command: z.array(z.string()).readonly().optional(),
  args: z.array(z.string()).readonly().optional(),
  env: z.array(EnvVarSchema).readonly().optional(),
  resources: z.object({
    limits: z.object({
      cpu: z.number(),
      memory: z.number(),
      gpu: z.number().optional(),
    }).optional(),
  }).optional(),
  ports: z.array(ContainerPortSchema).readonly().optional(),
  volumeMounts: z.array(VolumeMountSchema).readonly().optional(),
  livenessProbe: ProbeSpecSchema.optional(),
  readinessProbe: ProbeSpecSchema.optional(),
  startupProbe: ProbeSpecSchema.optional(),
  imagePullPolicy: z.string().optional(),
  tty: z.boolean().optional(),
  stdin: z.boolean().optional(),
  networkMode: z.string().optional(),
  providerOverrides: z.record(z.string(), z.unknown()).optional(),
});

export const VolumeSpecSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['NFSVolume', 'EmptyDirVolume', 'DiskVolume', 'SecretVolume', 'ConfigMapVolume', 'OSSVolume']),
  options: z.record(z.string(), z.unknown()).optional(),
});

export const PodSpecSchema = z.object({
  metadata: z.object({
    name: z.string().min(1),
    labels: z.record(z.string(), z.string()).optional(),
    annotations: z.record(z.string(), z.string()).optional(),
  }),
  spec: z.object({
    containers: z.array(ContainerSpecSchema).readonly().min(1),
    initContainers: z.array(ContainerSpecSchema).readonly().optional(),
    volumes: z.array(VolumeSpecSchema).readonly().optional(),
    restartPolicy: z.enum(['Always', 'OnFailure', 'Never']),
    priority: z.number().optional(),
    nodeSelector: z.record(z.string(), z.string()).optional(),
    terminationGracePeriodSeconds: z.number().optional(),
    secretRefs: z.array(z.object({
      secretName: z.string(),
      mountPath: z.string(),
      keys: z.array(z.string()).readonly().optional(),
      mode: z.number().optional(),
    })).readonly().optional(),
    resolvedSecrets: z.record(z.string(), z.object({
      value: z.string().optional(),
      platformRefs: z.object({
        eci: z.string().optional(),
        k8s: z.string().optional(),
        podman: z.string().optional(),
        aws: z.string().optional(),
      }).optional(),
    })).optional(),
    secretMounts: z.array(z.object({
      name: z.string(),
      mountPath: z.string(),
      items: z.array(z.object({
        key: z.string(),
        path: z.string(),
        mode: z.number().optional(),
      })).readonly().optional(),
    })).readonly().optional(),
  }),
  providerOverrides: z.record(z.string(), z.unknown()).optional(),
});
```

### 3b. pod/handler.ts — `z.custom<PodPhase>()` → `PodPhaseSchema`

**文件**: `src/features/pod/handler.ts:51`

```diff
- const phase = z.custom<PodPhase>().optional().parse(c.req.query('phase') || undefined);
+ const phase = PodPhaseSchema.optional().parse(c.req.query('phase') || undefined);
```

`PodPhaseSchema` 已在 `pod/response-schema.ts` 中定义，直接导入。

### 3c. pod/handler.ts — `z.record(z.string(), z.unknown())` → 具体 Schema

**文件**: `src/features/pod/handler.ts:156`

PATCH body 校验:

```diff
- const specPatch = z.record(z.string(), z.unknown()).parse(await c.req.json());
+ const specPatch = PodSpecPatchSchema.parse(await c.req.json());
```

在 `pod/response-schema.ts` 或新建的 `pod/schema.ts` 中定义:

```typescript
export const PodSpecPatchSchema = z.object({
  metadata: z.object({
    name: z.string().optional(),
    labels: z.record(z.string(), z.string()).optional(),
    annotations: z.record(z.string(), z.string()).optional(),
  }).optional(),
  spec: z.object({
    containers: z.array(ContainerSpecSchema).readonly().optional(),
    restartPolicy: z.enum(['Always', 'OnFailure', 'Never']).optional(),
  }).optional(),
  providerOverrides: z.record(z.string(), z.unknown()).optional(),
});
```

### 3d. template/handler.ts — `z.custom` 位置审计

| 行 | 位置 | 用途 | 修法 |
|---|---|---|---|
| 47 | `fromGeneratedTemplate` | `z.custom<Template['kind']>()` | `z.enum(['Container', 'ContainerGroup'])` |
| 49 | `fromGeneratedTemplate` | `z.custom<RegionId>()` | `z.string().brand('RegionId')` 或保留 + eslint-disable（branded string 类型在运行时就是 string） |
| 51 | `fromGeneratedTemplate` | `z.custom<ContainerDef[]>()` | 保留 — generated 模板数据已由构建脚本校验 |
| 52 | `fromGeneratedTemplate` | `z.custom<ContainerDef[]>()` | 同上 |
| 54 | `fromGeneratedTemplate` | `z.custom<HealthCheckDef[]>()` | 同上 |
| 55 | `fromGeneratedTemplate` | `z.custom<Record<string, unknown>>()` | `z.record(z.string(), z.unknown())` |
| 56 | `fromGeneratedTemplate` | `z.custom<Record<string, unknown>>()` | 同上 |
| 57 | `fromGeneratedTemplate` | `z.custom<PodSpec>()` | 保留 — Assembly PodSpec 是嵌套结构，generated 数据已校验 |
| 58 | `fromGeneratedTemplate` | `z.custom<TemplateInstanceLimit>()` | 保留 — generated 数据已校验 |
| 116 | `resolveTemplateSource` | `z.custom<Template>()` | 保留 — KV 反序列化 |

**修法**:

能替换为真实 Schema 的就替换（kind → z.enum, Record → z.record）。generated 模板数据路径的 `z.custom` 保留但加 `eslint-disable-next-line -- generated template data is pre-validated at build time`。

**实际改动**（最小集）:

```typescript
// L47:
- const kind = z.custom<Template['kind']>().optional().parse(s.kind);
+ const kind = z.enum(['Container', 'ContainerGroup']).optional().parse(s.kind);

// L55:
- const network = z.custom<Record<string, unknown>>().optional().parse(s.network);
+ const network = z.record(z.string(), z.unknown()).optional().parse(s.network);

// L56:
- const extensions = z.custom<Record<string, unknown>>().optional().parse(s.extensions);
+ const extensions = z.record(z.string(), z.unknown()).optional().parse(s.extensions);

// L49: RegionId 是 branded string — 运行时就是 string，用 z.string() 即可
- const region = z.custom<RegionId>().optional().parse(s.region);
+ const region = z.string().optional().parse(s.region);
```

其他 `z.custom` 处加 eslint-disable（generated data / KV 反序列化路径）。

### 3e. pod/service.ts — `as Record<string, unknown>` → Zod parse 收窄

**文件**: `src/core/pod/service.ts:114`

```diff
- const aliRegion = ((spec.providerOverrides?.alibaba as Record<string, unknown> | undefined)?.region as string | undefined) ?? 'cn-hangzhou';
+ const ali = AlibabaOverridesSchema.parse(spec.providerOverrides?.alibaba ?? {});
+ const aliRegion = ali.region ?? 'cn-hangzhou';
```

需要定义 `AlibabaOverridesSchema`。选择位置：`src/core/pod/schema.ts`（与 PodSpecSchema 同文件）。

```typescript
export const AlibabaOverridesSchema = z.object({
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
  eipBandwidth: z.number().optional(),
  account: z.string().optional(),
  healthMaxRetries: z.number().optional(),
  apiVersion: z.string().optional(),
  description: z.string().optional(),
  zoneId: z.string().optional(),
}).passthrough();
```

`.passthrough()` 允许透传未列出的字段（模板 extensions.providerOverrides 中的 spotInstanceType 等）。

### 3f. 验证

```bash
npm run typecheck  # 预期: PodSpecSchema 定义后, pod/handler.ts 无新增错误
npm run lint       # consistent-type-assertions 违规数下降
```

---

## Step 4 — 清理 template/assembly/types.ts 的断裂 import

> **文件**: `src/features/template/assembly/types.ts`
> **依赖**: 无（独立清理）
> **影响**: 移除对不存在文件的 import 引用

### 4a. 问题

`template/assembly/types.ts` 的 import:

```typescript
import type { BaseTemplate, DagEdge } from '../base.ts';    // template/base.ts — 不存在
import type { VolumeType, NFSVolumeConfig, ... } from '../types.ts';  // template/types.ts — 无这些导出
```

这些 import 来自从 `sandbox/assembly/` 搬家到 `template/assembly/` 时未更新的相对路径。原来 `../base.ts` 指向 `sandbox/base.ts`，`../types.ts` 指向 `sandbox/types.ts`。

这些类型（`BaseTemplate`, `DagEdge`, `VolumeTemplate`, `ContainerTemplate`, `AssemblyTemplate` 等）目前**没有任何消费者**——只有 `PodSpec` 和 `ServiceDefinition` 被 `template/types.ts` 和 `assembly-to-core.ts` 使用。

### 4b. 修法

将 `template/assembly/types.ts` 拆分为两个文件：

**保留在 `assembly/types.ts`**（有消费者的类型）:

```typescript
// PodSpec, ServiceDefinition, PortMapping, ResourceLimits,
// SharedNamespace, PodExitPolicy, TaskNode, TaskResult,
// ExecutionPlan, ExecutionPlanResult
```

**删除**（无消费者的类型）:

```typescript
// BaseTemplate, DagEdge, TemplateKind, VolumeTemplate,
// VolumeTemplateSpec, ContainerTemplate, ResourceTemplate,
// ResourceType, AssemblyTemplate, Template, 
// ResolveError, ResolveSuccess, ResolveFailure, ResolveResult
```

### 4c. 操作

1. 提取 `assembly/types.ts` 中仍被引用的类型到一个新文件 `assembly/pod-spec.ts`
2. 更新 `template/types.ts` 的 import：`from './assembly/types.ts'` → `from './assembly/pod-spec.ts'`
3. 更新 `assembly-to-core.ts` 的 import：`from './assembly/types.ts'` → `from './assembly/pod-spec.ts'`
4. 删除 `assembly/types.ts`（如果抽完后为空）
5. 或者直接把 `assembly/types.ts` 中无消费者的类型删掉，文件保留

**选择方案 5**——最小改动，不动 import 路径。

### 4d. 具体删除清单

```typescript
// 删除以下 export（无消费者）:
export enum TemplateKind { ... }
export interface VolumeTemplateSpec { ... }
export interface VolumeTemplate extends BaseTemplate<TemplateKind.Volume> { ... }
export interface ContainerTemplate extends BaseTemplate<TemplateKind.Container> { ... }
export enum ResourceType { ... }
export interface ResourceTemplate extends BaseTemplate<TemplateKind.Resource> { ... }
export interface AssemblyTemplate extends BaseTemplate<TemplateKind.Assembly> { ... }
export type Template = VolumeTemplate | ContainerTemplate | ResourceTemplate | AssemblyTemplate;
export interface ResolveError { ... }
export interface ResolveSuccess { ... }
export interface ResolveFailure { ... }
export type ResolveResult = ResolveSuccess | ResolveFailure;

// 删除 import:
- import type { BaseTemplate, DagEdge } from '../base.ts';
- import type { VolumeType, NFSVolumeConfig, DiskVolumeConfig, SecretVolumeConfig, ContainerConfig, CreateSandboxInput } from '../types.ts';

// 更新 import — 只保留仍需要的:
+ import type { InstanceId } from '../../../core/region/instance.ts';
```

注意：`PodSpec.region` 不需要额外 import，`InstanceId` 已有 import。检查是否还有其他引用 `VolumeType` 等——`assembly/types.ts` 中 `PodSpec` 和 `ServiceDefinition` 不使用这些 sandbox 类型。

### 4e. 验证

```bash
npm run typecheck  # 预期: 无新增错误。如果其他文件引用了被删除的类型，在此处发现并修复
```

---

## Step 5 — 删除 `sandbox/types.ts` 中不再被引用的类型

> **文件**: `src/features/sandbox/types.ts`
> **依赖**: Step 4（assembly types 先清理，确认不再引用 sandbox 类型）
> **影响**: 删除 Sandbox 剩余类型定义

### 5a. 仍被引用的类型（保留）

用 grep 确认每个类型的引用点：

```bash
grep -rn "from.*sandbox/types" src/ --include="*.ts"
```

预期引用：
- `applicator.ts` 引用 `Volume`, `VolumeMount`, `VolumeType`, `VolumeStatus`, `EmptyDirMedium`, `createVolumeId`, `NFSVolumeConfig`, `DiskVolumeConfig`, `SecretVolumeConfig`
- `core/pod/types.ts` 引用 `SandboxStatus`（仅用于 deprecated 函数）
- 测试文件引用

### 5b. 可安全删除的类型

| 类型 | 引用者 | 操作 |
|---|---|---|
| `SandboxStatus` enum | `core/pod/types.ts` (deprecated 函数) | 删除 `sandboxStatusToPodPhase` 后删此 enum |
| `SandboxId` | 当前无引用 | 删除 |
| `MetricSnapshotId` | 当前无引用 | 删除（working tree 新增的也需要删） |
| `Sandbox` interface | 当前无引用 | 删除 |
| `CreateSandboxInput` | `template/assembly/types.ts` (Step 4 已删引用) | 删除 |
| `SandboxNetworkConfig` | 当前无引用 | 删除 |
| `ContainerConfig` | 当前无引用 | 删除 |
| `InitContainerConfig` | 当前无引用 | 删除 |
| `ContainerRuntime` (sandbox 版本) | 当前无引用 | 删除 |
| `ContainerStatus` enum | 当前无引用 | 删除 |
| `ContainerState` (sandbox 版本) | 当前无引用 | 删除 |
| `NetworkInfo` | 当前无引用 | 删除 |
| `ContainerEvent` (sandbox 版本) | 当前无引用 | 删除 |
| `ResourceSpec` | 当前无引用 | 删除 |
| `PodCondition` (sandbox 版本) | 当前无引用 | 删除 |
| `ConditionStatus` (sandbox 版本) | 当前无引用 | 删除 |
| `ProviderIdentity` | 当前无引用 | 删除 |
| `TERMINAL_STATES` | 当前无引用 | 删除 |
| `DELETABLE_STATES` | 当前无引用 | 删除 |
| `VALID_TRANSITIONS` | 当前无引用 | 删除 |
| `isValidTransition` | 当前无引用 | 删除 |
| `isTerminal` | 当前无引用 | 删除 |

**保留**（被 applicator 和 core 引用）:

| 类型 | 引用者 |
|---|---|
| `Volume` | `applicator.ts` |
| `VolumeType` enum | `applicator.ts` |
| `VolumeStatus` enum | `applicator.ts` |
| `VolumeId` + `createVolumeId` | `applicator.ts` |
| `VolumeMount` | `applicator.ts` |
| `NFSVolumeConfig` | `applicator.ts` |
| `DiskVolumeConfig` | `applicator.ts` |
| `SecretVolumeConfig` | `applicator.ts` |
| `ConfigMapVolumeConfig` | — |
| `EmptyDirVolumeConfig` | — |
| `EmptyDirMedium` enum | `applicator.ts` |
| `OSSVolumeConfig` | — |
| `SandboxId` + `createSandboxId` | 各 handler（可能）— 需确认 |

### 5c. 同步删除 `sandboxStatusToPodPhase`

**文件**: `src/core/pod/types.ts:329-348`

```diff
- import { SandboxStatus } from '../../features/sandbox/types.ts';
-
- /**
-  * @deprecated Use transitionPod() with UpdateFromProvider instead
-  */
- export function sandboxStatusToPodPhase(status: SandboxStatus): PodPhase | null {
-   switch (status) { ... }
- }
```

确认无引用后删除。`PodService.syncRuntime()` 使用的是 `toPodPhase()`（内联在 `service.ts:33-53`），不依赖 `sandboxStatusToPodPhase()`。

### 5d. 验证

```bash
npm run typecheck  # 必须零新增错误
grep -rn "SandboxStatus\|CreateSandboxInput\|Sandbox\b" src/ --include="*.ts" | grep -v "node_modules\|\.test\.ts"
# 预期: 零匹配（或仅剩注释中的残留）
```

---

## Step 6 — 统一模板 handler 内部类型：`ContainerSpec` 去重

> **文件**: `src/features/template/types.ts`
> **依赖**: Step 5（sandbox types 清理完毕）
> **影响**: 消除命名冲突

### 6a. 问题

两个 `ContainerSpec`:

| 位置 | 语义 |
|---|---|
| `template/types.ts:48` | 模板层的容器组描述（region + instanceId + containers[]） |
| `core/pod/types.ts:65` | Pod 层的单容器规格（name + image + resources + probes...） |

命名冲突导致 import 时需要别名。`template/types.ts` 的 `ContainerSpec` 只在 template 内部使用（`Template.container` 字段），与 core `ContainerSpec` 无交集。

### 6b. 修法

将 `template/types.ts:48` 的 `ContainerSpec` 重命名为 `TemplateContainerSpec`:

```typescript
// 旧:
export interface ContainerSpec {
  readonly region: RegionId;
  readonly zone?: ZoneId | undefined;
  readonly instanceId?: InstanceId | undefined;
  readonly account?: string | undefined;
  readonly restartPolicy?: string | undefined;
  readonly containers: readonly ContainerDef[];
  readonly initContainers?: readonly ContainerDef[] | undefined;
}

// 新:
export interface TemplateContainerSpec {
  readonly region: RegionId;
  readonly zone?: ZoneId | undefined;
  readonly instanceId?: InstanceId | undefined;
  readonly account?: string | undefined;
  readonly restartPolicy?: string | undefined;
  readonly containers: readonly ContainerDef[];
  readonly initContainers?: readonly ContainerDef[] | undefined;
}
```

同步更新 `template/types.ts` 中 `Template.container` 的类型引用。

更新 `applicator.ts` 中的引用:
```diff
- import type { Template, ContainerSpec, ContainerDef, HealthCheckDef, TemplateStorage } from './types.ts';
+ import type { Template, TemplateContainerSpec, ContainerDef, HealthCheckDef, TemplateStorage } from './types.ts';
```

### 6c. 验证

```bash
npm run typecheck  # 零新增错误
```

---

## Step 7 — 全量验证

> **依赖**: Step 1-6 全部完成

```bash
npm run typecheck   # 必须零新增错误（361 个 podman/stub 预存错误不计）
npm run lint        # CEA 违规数下降（z.custom 减少, as 断言减少）
npm test            # 全部通过
npm run map         # 确认无新死代码
```

### 验证清单

- [ ] `POST /api/pods` 和 `POST /api/templates/:id/apply` 返回相同的 JSON 结构
- [ ] `z.custom<PodSpec>()` 已替换为 `PodSpecSchema`
- [ ] `as Record<string, unknown>` 已替换为 `AlibabaOverridesSchema.parse()`
- [ ] `template/assembly/types.ts` 不再 import 不存在的文件
- [ ] `sandbox/types.ts` 中 Sandbox 专属类型已删除
- [ ] `sandboxStatusToPodPhase` 已随 SandboxStatus 删除
- [ ] `TemplateContainerSpec` 不再与 core `ContainerSpec` 冲突

---

## 依赖图

```
Step 1 (响应统一) ──────────────────────────── 独立
Step 2 (securityRefNames 标记) ─────────────── 独立
Step 3 (CEA: z.custom/as/z.unknown) ───────── 独立
Step 4 (清理 assembly/types.ts imports) ───── 独立
  │
  └─→ Step 5 (删除 sandbox types) ◄────────── 依赖 4
        │
        └─→ Step 6 (ContainerSpec 去重) ◄──── 依赖 5
              │
              └─→ Step 7 (全量验证) ◄──────── 全部
```

- Step 1, 2, 3, 4 可并行
- Step 5 依赖 Step 4（先清理 assembly import 才能删 sandbox 类型）
- Step 6 依赖 Step 5（sandbox ContainerConfig 删除后无冲突）

---

## 预计变更量

| 步骤 | 新增 | 删除 | 修改 |
|---|---|---|---|
| Step 1 — 响应统一 | ~5 行 | ~3 行 | ~5 行 |
| Step 2 — securityRefNames 标记 | ~3 行 | 0 | 0 |
| Step 3 — CEA 合规 | ~120 行（PodSpecSchema） | ~5 行 | ~15 行 |
| Step 4 — 清理 assembly types | 0 | ~80 行 | ~3 行 |
| Step 5 — 删除 sandbox types | 0 | ~200 行 | ~5 行 |
| Step 6 — ContainerSpec 去重 | 0 | 0 | ~10 行 |
| Step 7 — 验证 | 0 | 0 | 0 |
| **合计** | **~128 行** | **~288 行** | **~38 行** |
