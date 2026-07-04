# Pod 统一开发日志

> **基线**: 2026-07-04, Pod v2 当前状态
> **目标**: PodEntity 成为唯一实体, Sandbox 消失, transitionPod 统一状态机, buildPodCreateParams 完成 Codec
> **总览**: 7 步, ~200 行新增, ~150 行删除

---

## 前置条件

- [ ] `npm run typecheck` 当前通过
- [ ] 已理解当前 Sandbox(11态) → Pod(5态) 的投影关系
- [ ] 已理解 `sandboxStatusToPodPhase()` 的映射逻辑

---

## Step 1 — PodEntity 加 `deletionTimestamp`

> **依赖**: 无
> **影响**: `PodEntity` 类型定义, `transition()` 调用点

### 1.1 修改 `src/core/pod/types.ts`

在 `PodEntity` 接口中添加字段:

```typescript
export interface PodEntity {
  readonly podId: PodId;
  readonly name: string;
  readonly spec: PodSpec;
  readonly phase: PodPhase;
  readonly providerId?: string | undefined;
  readonly deletionTimestamp?: string | undefined;  // ← NEW: ISO 8601, set on Terminate
  readonly network: PodNetwork;
  readonly containers: readonly ContainerRuntime[];
  readonly conditions: readonly PodCondition[];
  readonly events: readonly PodEvent[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly version: VersionId;
  readonly creatorId?: string | undefined;
  readonly templateRef?: string | undefined;
}
```

### 1.2 验证

```bash
npm run typecheck
```

预期错误仅在直接构造 `PodEntity` 的地方缺少新字段——这些都是 Step 2-5 要修的。如果出现无关错误，回退检查 `git diff`。

---

## Step 2 — 新建 `src/core/pod/transitions.ts`

> **依赖**: Step 1 (PodEntity 有 deletionTimestamp)
> **影响**: 新增文件，零修改现有文件

### 2.1 `PodAction` 类型

```typescript
export type PodAction =
  // ── 生命周期 ──
  | { readonly type: 'Provision'; readonly spec: PodSpec; readonly providerId: string; readonly network: PodNetwork; readonly creatorId?: string | undefined; readonly templateRef?: string | undefined }
  | { readonly type: 'Start' }
  | { readonly type: 'Stop' }
  | { readonly type: 'Restart' }
  | { readonly type: 'Update'; readonly spec: PodSpec }
  | { readonly type: 'Terminate' }
  // ── Provider 同步 ──
  | { readonly type: 'UpdateFromProvider'; readonly status: PodRuntime }
  // ── GC 专用 ──
  | { readonly type: 'ForceDelete' }
  | { readonly type: 'MarkFailed'; readonly reason: string }
  | { readonly type: 'MarkSucceeded' }
  | { readonly type: 'MarkExpired' };
```

### 2.2 `transitionPod` 纯函数

```typescript
import { generateVersionId } from '../brand.ts';
import type { PodEntity, PodPhase, PodCondition, PodAction } from './types.ts';
import { createPodId } from './types.ts';

function now(): string { return new Date().toISOString(); }
function nowMs(): number { return Date.now(); }

export function createPod(action: { readonly type: 'Provision' } & Extract<PodAction, { readonly type: 'Provision' }>): PodEntity {
  const initialPhase: PodPhase = 'Pending'; // provision 固定 Starting 相位
  return {
    podId: createPodId(crypto.randomUUID()),
    name: action.spec.metadata.name,
    spec: action.spec,
    phase: initialPhase,
    providerId: action.providerId,
    network: action.network,
    containers: [],
    conditions: [
      { type: 'PodScheduled', status: 'False', lastTransitionTime: nowMs() },
      { type: 'Initialized', status: 'False', lastTransitionTime: nowMs() },
    ],
    events: [],
    createdAt: nowMs(),
    updatedAt: nowMs(),
    version: generateVersionId(),
    creatorId: action.creatorId,
    templateRef: action.templateRef,
  };
}

export function transitionPod(pod: PodEntity, action: PodAction): PodEntity {
  switch (action.type) {
    case 'Provision':
      return createPod(action);

    case 'Stop': {
      if (pod.phase !== 'Running')
        throw new Error(`Cannot stop pod in phase ${pod.phase}`);
      return {
        ...pod,
        phase: 'Succeeded',
        conditions: filterControlConditions(pod.conditions),
        updatedAt: nowMs(),
        version: generateVersionId(),
      };
    }

    case 'Start': {
      if (pod.phase !== 'Succeeded' && pod.phase !== 'Failed')
        throw new Error(`Cannot start pod in phase ${pod.phase}`);
      return {
        ...pod,
        phase: 'Running',
        deletionTimestamp: undefined,
        conditions: [
          ...filterControlConditions(pod.conditions),
          { type: 'PodScheduled', status: 'True', lastTransitionTime: nowMs() },
        ],
        updatedAt: nowMs(),
        version: generateVersionId(),
      };
    }

    case 'Restart':
      return {
        ...pod,
        phase: 'Running',
        conditions: [
          ...filterControlConditions(pod.conditions),
          { type: 'PodScheduled', status: 'True', lastTransitionTime: nowMs() },
        ],
        updatedAt: nowMs(),
        version: generateVersionId(),
      };

    case 'Update':
      return {
        ...pod,
        spec: action.spec,
        phase: 'Running',
        conditions: upsertCondition(pod.conditions, { type: 'DisruptionTarget', status: 'True', reason: 'UpdateInProgress', lastTransitionTime: nowMs() }),
        updatedAt: nowMs(),
        version: generateVersionId(),
      };

    case 'Terminate': {
      if (pod.deletionTimestamp !== undefined)
        return pod; // 幂等——已标记删除
      return {
        ...pod,
        deletionTimestamp: now(),
        conditions: upsertCondition(pod.conditions, { type: 'DisruptionTarget', status: 'True', reason: 'TerminationRequested', lastTransitionTime: nowMs() }),
        updatedAt: nowMs(),
        version: generateVersionId(),
      };
    }

    case 'UpdateFromProvider': {
      const runtime = action.status;
      const newPhase = runtime.phase;

      // 保留平台控制类 Condition（不被 Provider 同步覆盖）
      const controlTypes = new Set(['DisruptionTarget']);
      const preserved = pod.conditions.filter(c => controlTypes.has(c.type));

      // Provider 带来的 Condition
      const providerConditionTypes = new Set(runtime.conditions.map(c => c.type));
      const merged = [
        ...preserved,
        ...runtime.conditions,
        // 保留不在 Provider 返回中的平台 Condition（如被 Provider 删除的调度状态）
        ...pod.conditions.filter(c => !controlTypes.has(c.type) && !providerConditionTypes.has(c.type)),
      ];

      return {
        ...pod,
        phase: newPhase,
        containers: runtime.containers,
        conditions: merged,
        events: runtime.events,
        network: runtime.network,
        updatedAt: nowMs(),
        version: generateVersionId(),
      };
    }

    case 'ForceDelete':
      return {
        ...pod,
        phase: 'Failed',
        deletionTimestamp: now(),
        conditions: upsertCondition(pod.conditions, { type: 'DisruptionTarget', status: 'True', reason: 'ForceDeleted', lastTransitionTime: nowMs() }),
        updatedAt: nowMs(),
        version: generateVersionId(),
      };

    case 'MarkFailed':
      return {
        ...pod,
        phase: 'Failed',
        conditions: filterControlConditions(pod.conditions),
        updatedAt: nowMs(),
        version: generateVersionId(),
      };

    case 'MarkSucceeded':
      return {
        ...pod,
        phase: 'Succeeded',
        conditions: filterControlConditions(pod.conditions),
        updatedAt: nowMs(),
        version: generateVersionId(),
      };

    case 'MarkExpired':
      return {
        ...pod,
        phase: 'Failed',
        conditions: filterControlConditions(pod.conditions),
        updatedAt: nowMs(),
        version: generateVersionId(),
      };

    default:
      void (action.type satisfies never);
      throw new Error(`Unknown PodAction: ${String((action as { type: string }).type)}`);
  }
}
```

### 2.3 辅助函数

```typescript
/** Condition types that are platform-controlled (not from provider). */
const CONTROL_CONDITION_TYPES = new Set(['DisruptionTarget']);

function filterControlConditions(conditions: readonly PodCondition[]): PodCondition[] {
  return conditions.filter(c => CONTROL_CONDITION_TYPES.has(c.type));
}

function upsertCondition(conditions: readonly PodCondition[], cond: PodCondition): PodCondition[] {
  const filtered = conditions.filter(c => c.type !== cond.type);
  return [...filtered, cond];
}
```

### 2.4 不变量（设计约束，代码不强 enforce）

| Action | 前置 Phase | 后置 Phase | 后置 Conditions |
|---|---|---|---|
| Provision | — | Pending | PodScheduled=False, Initialized=False |
| Start | Succeeded, Failed | Running | PodScheduled=True |
| Stop | Running | Succeeded | 清除非控制类 Condition |
| Restart | Running | Running | PodScheduled=True |
| Update | Running | Running | DisruptionTarget=True |
| Terminate | Running | Running | deletionTimestamp 设置, DisruptionTarget=True |
| UpdateFromProvider | * | Provider 返回 | 控制类 Condition 保留, 其他合并 |
| ForceDelete | * | Failed | DisruptionTarget=True, deletionTimestamp 设置 |
| MarkFailed | * | Failed | 清除非控制类 Condition |
| MarkSucceeded | * | Succeeded | 清除非控制类 Condition |
| MarkExpired | * | Failed | 清除非控制类 Condition |

### 2.5 验证

```bash
npm run typecheck
```

预期只有 PodEntity 缺乏 `deletionTimestamp` 的老构造点报错——这些在 Step 5 修复。新文件无需任何 import 即可独立编译（全部依赖来自 `./types.ts`）。

---

## Step 3 — 补齐 `buildPodCreateParams`

> **依赖**: 无（独立 codec 文件）
> **目标**: PodSpec → ECI API params 的完整映射, 覆盖 `podSpecToGroupInput` + `buildCreateParams` 的全部功能

### 3.1 现状检查

`buildPodCreateParams` 已覆盖: containers, initContainers, probes, volumeMounts, volumes, secretMounts, secretRefs, tags, dnsConfig, hostAliases, terminationGracePeriodSeconds, providerOverrides.

**缺失项**:

| 缺失 | 当前来源 | 回退位置 |
|---|---|---|
| `SecurityGroupId` | providerOverrides.alibaba.securityGroupId 或默认 | 检查 providerOverrides |
| `VSwitchId` + `ScheduleStrategy` | providerOverrides.alibaba.vSwitchId / subnetIds | 检查 providerOverrides |
| `AutoCreateEip` | providerOverrides.alibaba.autoCreateEip | 默认 `false` |
| `ImageRegistryCredential.N` | providerOverrides.alibaba.imagePullSecrets | 检查 providerOverrides |
| `SpotStrategy`/`SpotPriceLimit` | providerOverrides.alibaba | 透传 |
| `EipInstanceId` | providerOverrides.alibaba | 透传 |
| `RamRoleName` | providerOverrides.alibaba | 透传 |
| `NtpServer.N` | providerOverrides.alibaba | 透传 |
| `ActiveDeadlineSeconds` | providerOverrides.alibaba | 透传 |
| `ResourceGroupId` | providerOverrides.alibaba | 透传 |

这些都是 provider-specific，应放在 `providerOverrides.alibaba` 里，由 `buildPodCreateParams` 末尾的 `applyExtensionOverrides` 统一透传。

### 3.2 检查 `applyExtensionOverrides` 覆盖范围

```typescript
// eci-codec.ts 末尾已存在
if (spec.providerOverrides) {
  const raw = spec.providerOverrides;
  const flat = z.record(z.string(), z.unknown()).optional().parse(raw.alibaba) ?? raw;
  const ext = applyExtensionOverrides('alibaba', flat);
  for (const [k, v] of Object.entries(ext)) {
    p[k] = v;
  }
}
```

确认 `applyExtensionOverrides` 是否直接透传所有的 key-value 对，不做过滤。如果是，则所有 provider-specific 字段已经自动覆盖。

### 3.3 补齐缺失字段

在 `buildPodCreateParams` 的 network 段（L972 之前）加:

```typescript
  // ── Network defaults ──
  const aliOverride = spec.providerOverrides?.alibaba as Record<string, unknown> | undefined;
  p.SecurityGroupId = String(aliOverride?.securityGroupId ?? '');
  if (aliOverride?.vSwitchId) {
    p.VSwitchId = String(aliOverride.vSwitchId);
  }
  if (Array.isArray(aliOverride?.subnetIds) && aliOverride.subnetIds.length > 0) {
    p.VSwitchId = (aliOverride.subnetIds as string[]).join(',');
    p.ScheduleStrategy = 'VSwitchRandom';
    delete p.ZoneId;
  }
  p.AutoCreateEip = String(aliOverride?.autoCreateEip ?? false);

  p.AutoMatchImageCache = 'true';
```

### 3.4 验证

```bash
# 确保 buildPodCreateParams 能独立编译
npx tsc --noEmit src/providers/alibaba/eci-codec.ts
```

---

## Step 4 — Applicator 改输出 PodSpec

> **依赖**: 无（独立修改 applicator）
> **目标**: `applyTemplate()` 返回 `PodSpec` 而非 `CreateSandboxInput`

### 4.1 当前 `applyTemplate` 返回值分析

当前返回 `CreateSandboxInput`。独占字段（不在 PodSpec 中的）:

| 字段 | 目标位置 |
|---|---|
| `region` | `providerOverrides.alibaba.region` |
| `instanceId` | `providerOverrides.alibaba.instanceId` |
| `zoneId` | `providerOverrides.alibaba.zoneId` |
| `resourceSpec` | PodSpec spec.containers[].resources.limits |
| `securityRefNames` | 保留——S3 JWT 管线仍需要 |
| `account` | `providerOverrides.alibaba.account` |
| `healthMaxRetries` | `providerOverrides.alibaba.healthMaxRetries` |
| `apiVersion` | `providerOverrides.alibaba.apiVersion` |
| `description` | `providerOverrides.alibaba.description` |
| `network` | PodSpec — `securityGroupId` / `subnetIds` 走 providerOverrides.alibaba |
| `tags` | PodSpec `metadata.labels` |
| `restartPolicy` | PodSpec `spec.restartPolicy` |
| `containers` | PodSpec `spec.containers` |
| `initContainers` | PodSpec `spec.initContainers` |
| `volumes` | PodSpec `spec.volumes` |
| `securityResources` → `securityRefNames` | 保留——S3 JWT 管线 |
| `podSecretRefs` + `resolvedSecrets` | 保留——平台密钥管线 |

### 4.2 修改 `applyTemplate`

**文件**: `src/features/template/applicator.ts`

将返回值从 `CreateSandboxInput` 改为 `{ podSpec: PodSpec; securityRefNames: string[]; extra: AlibabaOverrides }`。

**`AlibabaOverrides` 类型** (放进 podSpec.providerOverrides.alibaba):

```typescript
interface AlibabaOverrides {
  region: string;
  instanceId?: string;
  zoneId?: string;
  account?: string;
  healthMaxRetries?: number;
  apiVersion?: string;
  description?: string;
  securityGroupId?: string;
  subnetIds?: string[];
  autoCreateEip?: boolean;
}
```

### 4.3 修改 `applyTemplate` 函数体

将原来的:
```typescript
return {
  name: ...,
  region: ...,
  resourceSpec: ...,
  ...
};
```

改为构造 `PodSpec` + `extra`:

```typescript
const alibabaOverrides: AlibabaOverrides = {
  region: region ?? String(container.region),
  instanceId: container.instanceId,
  ...(container.account ? { account: container.account } : {}),
  ...(ext?.healthMaxRetries !== undefined ? { healthMaxRetries: ext.healthMaxRetries } : {}),
};

const podSpec: PodSpec = {
  metadata: {
    name: name ?? `${tpl.name}-${crypto.randomUUID().slice(0, 6)}`,
    ...(inputTags?.length ? { labels: Object.fromEntries(inputTags.map(t => [t.key, t.value])) } : {}),
  },
  spec: {
    containers: containers.map(c => ({ ... })),
    ...(initContainers?.length ? { initContainers } : {}),
    restartPolicy,
    ...(volumes.length > 0 ? { volumes } : {}),
    ...(podSecretRefs.length > 0 ? { secretRefs: podSecretRefs, resolvedSecrets } : {}),
  },
  providerOverrides: {
    alibaba: alibabaOverrides,
  },
};

return { podSpec, securityRefNames };
```

### 4.4 验证

```bash
npm run typecheck
```

预期: applicator 自身通过编译; 调用 `applyTemplate()` 的地方 (`sandbox/index.ts` handler) 报类型错——这些在 Step 5 修复。

---

## Step 5 — PodService 全部方法改为调 `transitionPod`

> **依赖**: Step 2 (transitions.ts 存在), Step 4 (applicator 输出 PodSpec)
> **目标**: provision/stop/start/restart/update/terminate/syncRuntime 全部统一

### 5.1 `provision` — 使用 `createPod` + `buildPodCreateParams`

**修改**: `src/core/pod/service.ts`

```typescript
public async provision(spec: PodSpec, context?: ProvisionContext): Promise<PodEntity> {
  const cpu = spec.spec.containers.reduce((s, c) => s + (c.resources?.limits?.cpu ?? 0), 0) || 1;
  const memory = spec.spec.containers.reduce((s, c) => s + (c.resources?.limits?.memory ?? 0), 0) || 512;

  if (context?.creatorId && this.quotaService) {
    await this.quotaService.checkQuota(context.creatorId, cpu, memory);
  }

  const provider = await this.resolveProvider();
  // ── 改用 buildPodCreateParams（PodSpec 直连 ECI） ──
  const { region } = (spec.providerOverrides?.alibaba as Record<string, unknown> | undefined) ?? {};
  const params = buildPodCreateParams(spec, typeof region === 'string' ? region : 'cn-hangzhou');
  const { providerId } = await provider.create(params);  // 注意: create 接口需要适配 params 格式

  const pod = createPod({
    type: 'Provision',
    spec,
    providerId,
    network: {},  // provider create 返回值带 network info 时填入
    creatorId: context?.creatorId,
    templateRef: context?.templateRef,
  });

  const written = await this.store.insert(pod);
  if (!written) throw new AppError(500, 'CREATE_FAILED', 'Failed to persist Pod');
  await this.store.addToIndex(pod.podId);

  if (context?.creatorId && this.quotaService) {
    void this.quotaService.recordCreate(context.creatorId, cpu, memory);
  }

  this.audit?.write({ ... });
  void this.eventBus?.dispatch(createEvent('pod.provisioned', { ... }));

  return pod;
}
```

### 5.2 `stop` — 调 `transitionPod`

```typescript
public async stop(podId: PodId): Promise<PodEntity> {
  const pod = await this.store.getById(podId);
  if (!pod) throw new AppError(404, 'POD_NOT_FOUND', `Pod ${podId} not found`);
  if (pod.providerId) {
    const provider = await this.resolveProvider();
    try { await provider.stop?.(pod.providerId); } catch { /* best-effort */ }
  }
  const updated = transitionPod(pod, { type: 'Stop' });
  const result = await this.store.update(podId, updated, pod.version);
  // audit + event
  return result;
}
```

### 5.3 `start` / `restart` / `update` — 同模式

每个方法: get pod → `transitionPod(pod, action)` → `store.update()` → audit + event。

### 5.4 `terminate` — 分两步

```typescript
public async terminate(podId: PodId): Promise<void> {
  const pod = await this.store.getById(podId);
  if (!pod) throw new AppError(404, 'POD_NOT_FOUND', `Pod ${podId} not found`);

  // Step 1: 标记 Terminate (设置 deletionTimestamp + DisruptionTarget)
  const marked = transitionPod(pod, { type: 'Terminate' });
  await this.store.update(podId, marked, pod.version);

  // Step 2: 删 provider 资源 (best-effort)
  if (pod.providerId) { try { ... } catch { /* GC 重试 */ } }

  // Step 3: 标记终态
  const terminated = transitionPod(marked, { type: 'MarkFailed' });
  await this.store.update(podId, terminated, marked.version);
  await this.store.removeFromIndex(podId);

  // quota + audit + event
}
```

实际实现中，如果 provider delete 失败，Pod 留在 Terminate 状态（有 `deletionTimestamp`），GC 重试。

### 5.5 `syncRuntime` — 使用 `UpdateFromProvider`

```typescript
public async syncRuntime(podId: PodId): Promise<PodEntity> {
  const pod = await this.store.getById(podId);
  if (!pod?.providerId) throw new AppError(404, 'POD_NOT_FOUND', `Pod ${podId} not found or has no providerId`);
  const provider = await this.resolveProvider();
  const describeResult = await provider.describe({ ... });
  const runtime = describeResult.sandboxes[0];
  if (!runtime) throw new AppError(404, 'RUNTIME_NOT_FOUND', `No runtime found for pod ${podId}`);

  const podRuntime: PodRuntime = {
    podId, providerId: pod.providerId, name: pod.name,
    phase: toPodPhase(runtime.status),  // 现有函数
    conditions: [], // 从 runtime 提取
    containers: toContainers(runtime),  // 现有函数
    volumes: runtime.volumes?.map(v => ({ name: v.Name ?? '', type: v.Type ?? '' })) ?? [],
    events: runtime.events?.map(e => ({ reason: e.reason, type: e.type, message: e.message, count: e.count })) ?? [],
    network: { privateIp: runtime.network.privateIp, ... },
  };

  const updated = transitionPod(pod, { type: 'UpdateFromProvider', status: podRuntime });
  return this.store.update(podId, updated, pod.version);
}
```

### 5.6 `gcCleanup` — 读 Pod 状态决策

```typescript
public async gcCleanup(podId: PodId): Promise<void> {
  const pod = await this.store.getById(podId);
  if (!pod) return;

  // 检查 provider 是否存在
  const providerStatus = pod.providerId
    ? await this.checkProviderStatus(podId)
    : null;

  if (providerStatus === null && pod.providerId) {
    // provider-gone: 强制删除
    const updated = transitionPod(pod, { type: 'ForceDelete' });
    await this.store.update(podId, updated, pod.version);
    await this.store.removeFromIndex(podId);
    return;
  }

  // 检查超时
  const duration = Date.now() - pod.createdAt;
  if (pod.phase === 'Succeeded' || pod.phase === 'Failed') {
    if (duration > 60_000) { // 60s 软终态 → 清理
      const action = pod.phase === 'Succeeded' ? 'MarkSucceeded' as const : 'MarkFailed' as const;
      const updated = transitionPod(pod, { type: action, ...(action === 'MarkFailed' ? { reason: 'GC cleanup' } : {}) });
      // 尝试删 provider 资源
      if (pod.providerId) { try { await provider.delete(...); } catch {} }
      await this.store.update(podId, updated, pod.version);
      await this.store.removeFromIndex(podId);
    }
    return;
  }

  if (pod.deletionTimestamp && duration > 60_000) {
    // Terminating 超时 60s: 重试删除
    if (pod.providerId) { try { await provider.delete(...); } catch { return; /* 下次再试 */ } }
    const updated = transitionPod(pod, { type: 'ForceDelete' });
    await this.store.update(podId, updated, pod.version);
    await this.store.removeFromIndex(podId);
  }
}
```

### 5.7 验证

```bash
npm run typecheck
```

预期: PodService 所有方法通过编译。其他调用 `applyTemplate()` 返回值的地方报类型错（sandbox handler 等）——这些在 Step 7 修复或保留为兼容层。

---

## Step 6 — GC 注册到 event-loop

> **依赖**: Step 2 + Step 5 (gcCleanup 已改造)
> **目标**: GC 定时触发

### 6.1 修改 `src/core/app.ts`

在现有 event-loop 注册区域新增 `pod:gc` 回调:

```typescript
// 5b4. Pod GC — 周期性扫描并清理僵尸 Pod
eventBus.on('pod:gc', async () => {
  try {
    const ids = await podService.getAllIds();
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

### 6.2 验证

```bash
npm run typecheck
```

预期: app.ts 通过编译。

---

## Step 7 — 清理

> **依赖**: Step 3 + Step 5 (全链路已切换到 buildPodCreateParams + transitionPod)
> **目标**: 删除冗余类型和函数

### 7.1 删除清单

| 删除项 | 文件 | 原因 |
|---|---|---|
| `podSpecToGroupInput()` | `pod/service.ts:32-68` | 被 `buildPodCreateParams` 替代 |
| `Store.transition()` | `pod/store.ts:71-83` | 被 `transitionPod` + `Store.update` 替代 |
| `mergePodSpec()` | `pod/service.ts:480-496` | 被 `transitionPod({ type: 'Update', spec })` 替代 |
| `partialInputToPodSpecPatch()` | `sandbox/sandbox.service.ts:715-740` | Sandbox update path 废弃 |
| `sandboxStatusToPodPhase()` | `pod/types.ts:327-` | 保留——codec 仍需要（provider 返回值转 PodPhase），但标 `@deprecated` |
| `ISandboxService` | `sandbox/interfaces.ts` | Sandbox 消失后 interface 废弃——保留为兼容别名 |
| `SandboxService` | 整个 service | 不删除——保留为 `PodService` 的向后兼容 wrapper（handler 暂不改） |
| `SecurityResourceRef` | `sandbox/types.ts` | 已在之前 Phase 删除 |
| `autoGenerateKeys` | 残留 | 已在之前 Phase 删除 |

### 7.2 `PodStore.transition()` 处理

`transition()` 方法是 `PodStore` 的唯一写路径。改为:

```typescript
// pod/store.ts — 删除 transition(), 只保留 update()
public async update(podId: PodId, next: PodEntity, expectedVersion: VersionId | null): Promise<PodEntity> {
  const newVersion = await this.atomic.set(`${KEY_PREFIX}${podId}`, next, expectedVersion);
  if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');
  return next;
}
```

所有状态变更都通过 `transitionPod()` 生成新 `PodEntity`，然后 `store.update()` 写入。

### 7.3 SandboxService 保留策略

`SandboxService` **不删除**——它是 `POST /api/sandboxes` 的 handler 后端。在 Step 6 完成前，SandboxService 仍然作为 API 兼容层存在，内部委托给 PodService。后续可以渐进式迁移 handler 到 `POST /api/pods`。

### 7.4 验证

```bash
npm run typecheck   # 必须通过
npm run lint        # 必须通过
npm test            # 必须通过
npm run map         # 确认无新死代码
```

---

## 依赖图

```
Step 1 (deletionTimestamp)
  │
  ▼
Step 2 (transitions.ts) ──────────────────────┐
  │                                            │
  │    Step 3 (buildPodCreateParams) ───┐       │
  │    Step 4 (applicator → PodSpec)     │       │
  │         │                            │       │
  │         ▼                            │       │
  └──► Step 5 (PodService 统一) ◄────────┘       │
              │                                  │
              ▼                                  │
         Step 6 (GC event-loop)                  │
              │                                  │
              ▼                                  │
         Step 7 (清理) ◄─────────────────────────┘
```

- Step 3 和 Step 4 与 Step 2 并行
- Step 5 等待 Step 2 + Step 3 + Step 4
- Step 6 等待 Step 2 + Step 5
- Step 7 等待 Step 3 + Step 5

---

## 风险与回滚

- 每步一个 commit
- Step 5 改动最大——PodService 7 个方法全部重写。建议先改 provision + stop, typecheck 通过后再改其余 5 个
- SandboxService 保留为向后兼容 wrapper——不冒一次性删除 API 的风险
- Step 7 里 `podSpecToGroupInput` / `mergePodSpec` 的删除是最后一步——确认全链路到 `buildPodCreateParams` 的切换完成后方可删除
