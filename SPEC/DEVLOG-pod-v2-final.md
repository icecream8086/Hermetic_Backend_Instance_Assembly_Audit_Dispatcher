# Pod v2 最终统一 — 开发文档

> **日期**: 2026-07-05
> **基线**: PodService 独立运行，template apply 已切至 PodService，Sandbox 路径仅存残留引用
> **目标**: 消灭 v1/v2 双轨制，Template 直接嵌入 core PodSpec，零运行时转换，删除 Sandbox 残留
> **总览**: 4 Phase，~1,300 行删除，~450 行新增，21 个 YAML 文件重写

---

## 架构决策（来自 grill session 28 问）

| 决策 | 结论 |
|---|---|
| 唯一实体 | core `PodSpec` (K8s 标准 + `providerOverrides`)，所有路径最终输出此格式 |
| Template 格式 | `kind: 'Pod'`，`spec: PodSpec` (core)，+ `dependsOn`/`singleton`/`instanceLimit` |
| v1 去向 | 离线迁移后完全删除，运行时无 v1/v2 分支 |
| v2 assembly PodSpec 去向 | 删除，内置 YAML 直接写 core PodSpec |
| 配置合并 | `mergePodSpec` 在 DAG 继承时运行，基于 K8s Strategic Merge |
| 迁移方式 | 临时 HTTP endpoint，一次性洗数据，执行后删除 |
| `securityRefNames` | 放入 `providerOverrides.alibaba.securityRefNames` |
| `gpuType` | 正式加入 `ContainerSpec.resources.limits.gpuType` |
| Volume 类型 | 搬入 `core/volume/types.ts` |
| `kind` 字段 | 保留，统一为 `'Pod'`，作元数据锚点 |

---

## Phase 0 — 前置检查

在开始任何修改前，确保基线干净：

```bash
npm run typecheck   # 确认当前错误数（361 个 podman/stub 预存错误忽略）
npm run lint        # 确认当前违规数
npm test            # 确认全量通过
```

---

## Phase A — 使系统只认新格式（结构搭建）

### A1. `gpuType` 正式加入 `ContainerSpec.resources.limits`

**文件**: `src/core/pod/types.ts`

当前类型定义缺少 `gpuType` 但 `applicator.ts` 在运行时注入了它。该字段属于 K8s 扩展资源命名惯例。

```typescript
// 在 ContainerSpec.resources.limits 中：
readonly gpuType?: string | undefined;  // e.g. "nvidia.com/gpu", "A100", "T4"
```

**验证**: `npm run typecheck`

---

### A2. 新建 `core/volume/types.ts`

**文件**: `src/core/volume/types.ts`（新文件）

从 `sandbox/types.ts` 中提取以下通用存储类型，不依赖任何 Sandbox 概念：

- `VolumeId`, `createVolumeId`
- `VolumeType` enum
- `VolumeStatus` enum
- `EmptyDirMedium` enum
- `NFSVolumeConfig`, `DiskVolumeConfig`, `SecretVolumeConfig`, `ConfigMapVolumeConfig`, `OSSVolumeConfig`, `EmptyDirVolumeConfig`
- `Volume` interface (extends `BaseEntity<VolumeId, VolumeStatus>`)
- `VolumeMount` interface

出口 barrel：`src/core/volume/index.ts`（导出所有类型）。

**引用更新**：所有从 `../sandbox/types.ts` 导入 Volume 类型的文件改为从 `../../core/volume/types.ts` 导入：

| 文件 | 更新内容 |
|---|---|
| `features/volume/types.ts` | `import ... from '../../core/volume/types.ts'` |
| `features/volume/service.ts` | 同上 |
| `features/volume/schema.ts` | 同上 |
| `features/volume/response-schema.ts` | 同上 |
| `features/volume/entity-schema.ts` | 同上 |
| `core/state-machine/transitions.ts` | `VolumeStatus`, `ContainerStatus` 改为 core 版本 |

**验证**: `npm run typecheck` — 预期无新增错误。sandbox/types.ts 中仍保留这些类型的副本（直到 Phase C 删除）。

---

### A3. 新建 `core/pod/merge.ts`

**文件**: `src/core/pod/merge.ts`（新文件）

实现 ~80 行的 `mergePodSpec` 纯函数，基于 K8s Strategic Merge Patch 思想。

```typescript
import type { PodSpec } from './types.ts';

/**
 * Strategic merge of two PodSpecs. Child values override parent.
 *
 * Merge rules (K8s-aligned):
 * - metadata.labels        → child overwrites parent entirely
 * - spec.containers        → merge by name (child replaces same-name container)
 * - spec.initContainers    → merge by name
 * - spec.volumes           → merge by id
 * - spec.restartPolicy     → child overrides parent
 * - spec.dnsConfig         → child overrides parent
 * - spec.hostAliases       → child overrides parent
 * - spec.priority          → child overrides parent
 * - spec.nodeSelector      → child overrides parent
 * - spec.terminationGracePeriodSeconds → child overrides parent
 * - spec.secretRefs        → child overrides parent
 * - spec.resolvedSecrets   → shallow merge by key
 * - spec.secretMounts      → merge by name
 * - providerOverrides      → shallow merge by provider key
 *
 * Scalar fields and absent arrays in child are inherited from parent.
 */
export function mergePodSpec(parent: PodSpec, child: PodSpec): PodSpec {
  // ... implementation
}
```

**验证**: 编写 `mergePodSpec` 的单元测试（新增 `tests/core/pod/merge.test.ts`），覆盖：容器按名合并、volume 按 id 合并、providerOverrides 浅合并、子模板标量覆盖、父模板独有的保留。

---

### A4. 修改 `Template` 类型为新格式

**文件**: `src/features/template/types.ts`

```typescript
// 删除以下 export（迁移到 core/volume/types.ts 或删除）:
// - ContainerDef        → 删除（v1 格式，不再需要）
// - TemplateContainerSpec → 删除
// - HealthCheckDef      → 删除
// - NetworkSpec         → 删除
// - TemplateStorage     → 删除
// - TemplateExtensions  → 删除
// - ContainerSecretBinding → 删除（security 相关保留逻辑迁移到 DSL 层，后续补）

// Template 类型精简为:
export interface Template {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly apiVersion: string;
  readonly kind: 'Pod';
  readonly metadata?: {
    readonly labels?: Record<string, string> | undefined;
    readonly annotations?: Record<string, string> | undefined;
  } | undefined;
  readonly spec: import('../../core/pod/types.ts').PodSpec;
  readonly dependsOn?: readonly string[] | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly creatorId?: string | undefined;
  readonly visibility?: TemplateVisibility | undefined;
  readonly singleton?: boolean | undefined;
  readonly instanceLimit?: TemplateInstanceLimit | undefined;
  readonly resourceBinding?: TemplateResourceBinding | undefined;
}

// 删除 CreateTemplateInput 和 UpdateTemplateInput
```

**注意**: 旧 `Template` 类型中 `dependsOn` 由 `string[]` 改为 `readonly string[]` 以与 K8s 惯例保持一致。

**文件**: `src/features/template/response-schema.ts`

```typescript
// kind 从 z.enum(['Container', 'ContainerGroup']) 改为 z.enum(['Pod'])
// 删除 container, healthChecks, network, extensions, podSpec 字段
// 新增 spec 字段
export const TemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  apiVersion: z.string(),
  kind: z.enum(['Pod']),
  metadata: z.object({
    labels: z.record(z.string(), z.string()).optional(),
    annotations: z.record(z.string(), z.string()).optional(),
  }).optional(),
  spec: z.object({}), // 简化为空对象占位 (core PodSpec 内容太多不适合全量展开)
  dependsOn: z.array(z.string()).readonly().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  creatorId: z.string().optional(),
  visibility: z.enum(['public', 'private']).optional(),
  singleton: z.boolean().optional(),
  instanceLimit: z.object({
    type: z.enum(['fixed', 'perUser', 'perSystem']),
    max: z.number(),
  }).optional(),
  resourceBinding: z.object({
    domain: z.string().optional(),
    port: z.number().optional(),
  }).optional(),
});
```

**验证**: `npm run typecheck` — 预期 template handler 和 applicator 大量报错（类型不匹配），这些在 A5-A7 中逐步修复。

---

### A5. 重写内置 YAML 文件

**目标**: 21 个 `.yml` 文件全部改为新格式 (`kind: Pod`, `spec` 为 core PodSpec)。

#### 映射规则（v1 → core PodSpec）

| v1 字段 | core PodSpec 位置 |
|---|---|
| `name` | `spec.metadata.name` |
| `kind: Container` | `kind: Pod` |
| `restartPolicy` | `spec.spec.restartPolicy` |
| `containers[]` | `spec.spec.containers[]` (直接迁移，`env`, `ports`, `resources`, `command`, `args`, `image` 字段不变) |
| `containers[].livenessProbe` | `spec.spec.containers[].livenessProbe` (不变) |
| `containers[].readinessProbe` | `spec.spec.containers[].readinessProbe` (不变) |
| `containers[].imagePullPolicy` | `spec.spec.containers[].imagePullPolicy` (不变) |
| `containers[].stdin` / `tty` | `spec.spec.containers[].stdin` / `tty` (不变) |
| `containers[].providerOverrides` | `spec.spec.containers[].providerOverrides` (不变) |
| `containers[].resources.limits.gpuType` | 直接保留在 `resources.limits.gpuType` (A1 已加入类型) |
| `initContainers[]` | `spec.spec.initContainers[]` (同 containers 映射) |
| `healthChecks[]` | 拆解为目标容器上的 `livenessProbe` / `readinessProbe` / `startupProbe` |
| `network.mode` | 忽略 (ECI 专有, 进 providerOverrides) |
| `network.vpc.securityGroupId` | `spec.providerOverrides.alibaba.securityGroupId` |
| `network.vpc.subnetIds` | `spec.providerOverrides.alibaba.subnetIds` |
| `extensions.providerOverrides.alibaba.*` | `spec.providerOverrides.alibaba.*` (直接透传) |
| `extensions.healthMaxRetries` | `spec.providerOverrides.alibaba.healthMaxRetries` |
| `extensions.storage[]` | 拆解为 `spec.spec.volumes[]` + `spec.spec.containers[0].volumeMounts[]` (复杂模板手动处理) |
| `region` (根级) | `spec.providerOverrides.alibaba.region` |
| `provider` (根级) | 忽略 (由 provider 选择逻辑决定) |
| `singleton` (根级) | 保留为 Template 顶层字段 |
| `dependsOn` (根级) | 保留为 Template 顶层字段 |
| `apiVersion` (根级) | 保留为 `hbi-aad/v1` |
| `instanceId` | `spec.providerOverrides.alibaba.instanceId` |
| `account` | `spec.providerOverrides.alibaba.account` |

#### assembly v2 格式 (ContainerGroup → core PodSpec)

| `podSpec` 字段 | core PodSpec 位置 |
|---|---|
| `podSpec.name` | `spec.metadata.name` |
| `podSpec.region` | `spec.providerOverrides.alibaba.region` |
| `podSpec.instanceId` | `spec.providerOverrides.alibaba.instanceId` |
| `podSpec.labels` | `spec.metadata.labels` |
| `podSpec.resources` (Pod级) | `spec.providerOverrides.alibaba` (透传 cpu/memory) |
| `podSpec.services[name].image` | `spec.spec.containers[i].image` |
| `podSpec.services[name].command` | `spec.spec.containers[i].command` (normalizeCommand 逻辑: string→['/bin/sh','-c'], array→直接) |
| `podSpec.services[name].environment` | `spec.spec.containers[i].env` (Record→{name,value}[]) |
| `podSpec.services[name].ports[]` | `spec.spec.containers[i].ports[]` |
| `podSpec.services[name].resources.cpu` | `spec.spec.containers[i].resources.limits.cpu` (parseFloat) |
| `podSpec.services[name].resources.memory` | `spec.spec.containers[i].resources.limits.memory` (parseMemoryString: Mi→number) |
| `podSpec.services[name].volumes[]` | `spec.spec.volumes[]` (source→EmptyDirVolume) + `spec.spec.containers[0].volumeMounts[]` |
| `podSpec.services[name].dependsOn` | 忽略（无运行时依赖保证） |

#### 逐个模板重写清单

以下 21 个文件全部在 `src/features/template/templates/` 下，需逐一重写：

**简单模板（仅容器定义，无 DAG/healthCheck/network/storage）：**

| 文件 | 当前格式 | 重写要点 |
|---|---|---|
| `base-alpine.yml` | v1, 1 容器 sleep 3600 | 直接照搬 containers→spec.spec.containers |
| `fedora.yml` | v1, 1 容器 + 1 个 livenessProbe | probe 保持在容器上，healthChecks→直接在容器 spec 上 |
| `nginx.yml` | v1, 1 容器 + 2 个 healthCheck | 同 fedora |
| `nginx-arg.yml` | v1, 1 容器 command+args | command/args 保持原有格式 |
| `gpu-inference.yml` | v1, 1 GPU 容器 | gpuType 保留在 resources.limits |
| `redis-cache.yml` | v1, 1 容器 + port + TCP probe | probe 不变 |
| `sftp-server-podman.yml` | v1, 1 容器 podman provider | provider 信息进 providerOverrides |
| `web-service.yml` | v1, 1 容器 + dependsOn + providerOverrides | dependsOn 保留为 Template 顶层 |

**中等模板（有 DAG 继承 / 多容器 / network / extensions）：**

| 文件 | 重写要点 |
|---|---|
| `base-network.yml` | network.vpc → providerOverrides.alibaba.securityGroupId + subnetIds; providerOverrides.alibaba.instanceType 不变 |
| `custom-alpine.yml` | dependsOn base-alpine → Template.dependsOn; containers 直接照搬（覆盖父模板同名字段——mergePodSpec 中按名合并） |
| `api-service.yml` | dependsOn base-network; containers 照搬; containers[].providerOverrides 不变 |
| `full-stack.yml` | dependsOn custom-alpine+nginx; containers 仅含 env（覆盖父模板）; extensions.providerOverrides 搬入 spec.providerOverrides |
| `minio-server.yml` | singleton → Template.singleton; containers 照搬; healthChecks 拆到容器上 |
| `sftp-server.yml` | region → providerOverrides.alibaba.region; network VPC 配置; extensions.healthMaxRetries → providerOverrides.alibaba; extensions.providerOverrides 合并 |
| `vsftp-pub.yml` | 同 sftp-server, 加 spotStrategy 等 ECI 参数 |
| `vsftp_GPU.yml` | 同 vsftp-pub, 加 GPU 参数 |

**复杂模板（多容器 DAG 合并 / GPU + spot / v2 assembly 格式）：**

| 文件 | 重写要点 |
|---|---|
| `gpu-compute.yml` | 多 zone subnetIds; GPU + spot; 丰富的 probe 配置; network VPC; extensions.providerOverrides 全量搬入 |
| `prod-stack.yml` | dependsOn web-service+api-service+redis-cache (3 继承); containers 为 env 覆盖（mergePodSpec 按名合并）; extensions 进 spec.providerOverrides |
| `demo-pod.yml` | **v2→新格式**: services.web/services.sidecar → spec.spec.containers[]; services 中的 resources (字符串格式) → limits (数字); volumes 映射 |
| `lifecycle-busybox.yml` | **v2→新格式**: services.consumer/producer → containers[]; dependsOn 忽略 |
| `lifecycle-test.yml` | **v2→新格式**: 同 lifecycle-busybox, 但 image 使用具体 registry URL |

#### 示例：`demo-pod.yml` 重写前后

**旧 (v2 assembly 格式):**
```yaml
name: demo-pod
description: v2 容器组
apiVersion: hbi-aad/v2
kind: ContainerGroup
region: local
podSpec:
  name: demo-pod
  region: local
  resources:
    cpu: "1.0"
    memory: "512Mi"
  services:
    web:
      image: docker.io/library/nginx:latest
      command: ["nginx", "-g", "daemon off;"]
      ports:
        - containerPort: 80
          protocol: TCP
      resources:
        cpu: "0.5"
        memory: "128Mi"
    sidecar:
      image: docker.io/library/alpine:latest
      command: ["sh", "-c", "while true; do echo sidecar alive; sleep 30; done"]
      dependsOn: ["web"]
      resources:
        cpu: "0.25"
        memory: "64Mi"
```

**新:**
```yaml
name: demo-pod
description: Pod — nginx + alpine 共享网络
apiVersion: hbi-aad/v1
kind: Pod
spec:
  metadata:
    name: demo-pod
  spec:
    containers:
      - name: demo-pod-web
        image: docker.io/library/nginx:latest
        command: ["nginx", "-g", "daemon off;"]
        ports:
          - containerPort: 80
            protocol: TCP
        resources:
          limits:
            cpu: 0.5
            memory: 128
      - name: demo-pod-sidecar
        image: docker.io/library/alpine:latest
        command: ["sh", "-c", "while true; do echo sidecar alive; sleep 30; done"]
        resources:
          limits:
            cpu: 0.25
            memory: 64
    restartPolicy: Never
  providerOverrides:
    alibaba:
      region: local
```

#### 示例：`gpu-compute.yml` 重写前后

**旧 (v1 格式):**
```yaml
name: gpu-compute
apiVersion: hbi-aad/v1
kind: Container
region: cn-hangzhou
restartPolicy: OnFailure
containers:
  - name: gpu-worker
    image: docker.io/nvidia/cuda:12.0-runtime-ubuntu22.04
    command: ["nvidia-smi"]
    ports:
      - containerPort: 8888
        protocol: TCP
    env:
      - name: NVIDIA_VISIBLE_DEVICES
        value: all
      - name: CUDA_VISIBLE_DEVICES
        value: "0"
    resources:
      limits:
        cpu: 8
        memory: 32768
        gpu: 1
        gpuType: nvidia.com/gpu
    livenessProbe:
      tcpSocket:
        port: 8888
      periodSeconds: 30
      initialDelaySeconds: 60
    readinessProbe:
      exec:
        command: ["nvidia-smi"]
      periodSeconds: 30
      initialDelaySeconds: 30
    imagePullPolicy: IfNotPresent
    stdin: true
    tty: true
extensions:
  healthMaxRetries: 3
  providerOverrides:
    alibaba:
      spotStrategy: SpotAsPriceGo
      instanceType: ecs.gn6v-c8g1.2xlarge
      ingressBandwidth: 100
      egressBandwidth: 100
      autoCreateEip: true
      eipBandwidth: 50
      autoMatchImageCache: true
      cpuArchitecture: AMD64
network:
  mode: vpc
  vpc:
    securityGroupId: sg-bp16o5urk39itwcqmdzj
    subnetIds:
      - vsw-bp1xx36ys1jou7o1bsdpp
      - vsw-bp1grwzlgy2739dxnskbz
      - vsw-bp1rv5m61jx4kmld0cc12
      - vsw-bp1wfyusfye82wm3d3zew
```

**新:**
```yaml
name: gpu-compute
description: GPU compute instance — NVIDIA CUDA 12.0 runtime, T4 GPU, spot instance
apiVersion: hbi-aad/v1
kind: Pod
spec:
  metadata:
    name: gpu-compute
  spec:
    containers:
      - name: gpu-worker
        image: docker.io/nvidia/cuda:12.0-runtime-ubuntu22.04
        command: ["nvidia-smi"]
        ports:
          - containerPort: 8888
            protocol: TCP
        env:
          - name: NVIDIA_VISIBLE_DEVICES
            value: all
          - name: CUDA_VISIBLE_DEVICES
            value: "0"
        resources:
          limits:
            cpu: 8
            memory: 32768
            gpu: 1
            gpuType: nvidia.com/gpu
        livenessProbe:
          tcpSocket:
            port: 8888
          periodSeconds: 30
          initialDelaySeconds: 60
        readinessProbe:
          exec:
            command: ["nvidia-smi"]
          periodSeconds: 30
          initialDelaySeconds: 30
        imagePullPolicy: IfNotPresent
        stdin: true
        tty: true
    restartPolicy: OnFailure
  providerOverrides:
    alibaba:
      region: cn-hangzhou
      securityGroupId: sg-bp16o5urk39itwcqmdzj
      subnetIds:
        - vsw-bp1xx36ys1jou7o1bsdpp
        - vsw-bp1grwzlgy2739dxnskbz
        - vsw-bp1rv5m61jx4kmld0cc12
        - vsw-bp1wfyusfye82wm3d3zew
      spotStrategy: SpotAsPriceGo
      instanceType: ecs.gn6v-c8g1.2xlarge
      ingressBandwidth: 100
      egressBandwidth: 100
      autoCreateEip: true
      eipBandwidth: 50
      autoMatchImageCache: true
      cpuArchitecture: AMD64
      healthMaxRetries: 3
```

**验证**: 运行 `npm run generate`，确认 `templates.generated.ts` 重新生成且 `spec` 字段为 `PodSpec` 形状。

---

### A6. 简化 `fromGeneratedTemplate`

**文件**: `src/features/template/handler.ts`

当前 `fromGeneratedTemplate`（L40-97）做大量 v1/v2 字段拆解和重组。改为：

```typescript
/** Convert a YAML-generated InstanceTemplateDef to the new Template shape. */
function fromGeneratedTemplate(def: InstanceTemplateDef): Template {
  const now = Date.now();
  const s = def.spec as Record<string, unknown>;

  // Template 顶层字段
  const dependsOn = z.array(z.string()).optional().parse(s.dependsOn ?? []);
  const singleton = z.boolean().optional().parse(s.singleton);
  const instanceLimit = z.custom<TemplateInstanceLimit>().optional().parse(s.instanceLimit);

  // spec 字段直接是 core PodSpec（从 YAML 来的，已经过生成脚本校验）
  const podSpec = z.custom<import('../../core/pod/types.ts').PodSpec>().parse(s.spec);

  return {
    id: def.id,
    name: def.name,
    description: def.description,
    apiVersion: z.string().parse(s.apiVersion ?? 'hbi-aad/v1'),
    kind: 'Pod',
    spec: podSpec,
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
    createdAt: now,
    updatedAt: now,
    ...(singleton !== undefined ? { singleton } : {}),
    ...(instanceLimit !== undefined ? { instanceLimit } : {}),
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- generated template construction; validated at build time
  } as Template;
}
```

Zod `z.custom` 处加 `eslint-disable-next-line -- generated template data is pre-validated at build time`。

**验证**: `npm run typecheck`

---

### A7. 修改 `resolveTemplate` — DAG 合并改用 `mergePodSpec`

**文件**: `src/features/template/handler.ts`

当前 `resolveTemplateWithChain`（L231-249）用 `deepMerge` 拼装 `container`/`healthChecks`/`network`/`extensions`/`podSpec`。

改为：

```typescript
async function resolveTemplateWithChain(atomic: IAtomicStore, id: string): Promise<{ template: Template; chain: readonly string[] }> {
  const allTemplates = await listAllLive(atomic);
  const tpl = allTemplates.find(t => t.id === id);
  if (!tpl) throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'Template not found');

  const chain = resolveDag(allTemplates, [id]).reverse();
  const chainIds = chain.map(t => t.id);

  // DAG 合并：按序合并每个模板的 PodSpec
  let mergedSpec: PodSpec = tpl.spec;
  for (const t of chain) {
    if (t.id === id) continue; // 跳过自身（作为起点）
    mergedSpec = mergePodSpec(mergedSpec, t.spec);
  }

  return { template: { ...tpl, spec: mergedSpec }, chain: chainIds };
}
```

**删除**: `deepMerge`、`mergeByName`、`mergeHealthChecks` 函数（不再需要）。

**验证**: `npm run typecheck` — 确认 DAG 合并逻辑通过类型检查。

---

### A8. 修改 Template API handler

**文件**: `src/features/template/handler.ts`

**POST / (创建模板)**: bodySchema 只接受新格式。删除 `container`、`network`、`extensions`、`podSpec`、`healthChecks` 的接收和处理。

```typescript
const bodySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  apiVersion: z.string().optional(),
  kind: z.enum(['Pod']).optional(),
  spec: z.custom<PodSpec>(),  // core PodSpec
  dependsOn: z.array(z.string()).optional(),
  singleton: z.boolean().optional(),
  instanceLimit: z.object({
    type: z.enum(['fixed', 'perUser', 'perSystem']),
    max: z.number(),
  }).optional(),
  resourceBinding: z.object({
    domain: z.string().optional(),
    port: z.number().optional(),
  }).optional(),
  metadata: z.object({
    labels: z.record(z.string(), z.string()).optional(),
    annotations: z.record(z.string(), z.string()).optional(),
  }).optional(),
}).passthrough();
```

**PUT /:id (更新模板)**: 同样只接受新格式字段。删除 `container`/`network`/`extensions`/`podSpec` 的合并逻辑。

**POST /:id/apply**: 极简化为：

```typescript
// 所有模板统一路径 — 无 v1/v2 分支
const resolved = await resolveTemplate(atomic, c.req.param('id'));
const body = await z.object({
  name: z.string().optional(),
  region: z.string().optional(),
  provider: z.string().optional(),
}).parse(c.req.json());

await claimInstanceSlot(atomic, resolved, user?.id ?? 'anonymous');
await claimResourceBinding(atomic, resolved);

const pod = await podSvc.provision(resolved.spec, {
  creatorId: user?.id,
  templateRef: resolved.id,
});

c.var.audit.write({
  level: KernLevel.NOTICE,
  facility: 'template',
  message: `Template applied — ${resolved.name} → pod ${pod.podId}`,
  metadata: { eventType: 'template.applied', templateId: resolved.id, podId: pod.podId, actorId: user?.id },
});

return c.json(ok({
  podId: pod.podId,
  providerId: pod.providerId,
  phase: pod.phase,
  name: pod.name,
}), 201);
```

**删除**: v1/v2 分支代码，`applyTemplate` 调用，`assemblyToCorePodSpec` 调用，`SandboxService` 实例化代码。

**删除的 import**:
- `import { applyTemplate } from './applicator.ts'`
- `import { assemblyToCorePodSpec } from './assembly-to-core.ts'`
- `import { PodSpec } from './assembly/types.ts'`

**验证**: `npm run typecheck` — 预期 handler 编译通过。

---

### A9. 修改 `template/index.ts`

**文件**: `src/features/template/index.ts`

删除 `SandboxService` 相关逻辑（已不再需要），只保留 `PodService` 构造和 `createTemplateRouter` 调用。

验证 `createRouter` 签名与 `generated.ts` 的 `FeatureDeps` 兼容。

**验证**: `npm run typecheck`

---

## Phase B — 数据迁移

### B1. 实现迁移端点

**文件**: `src/core/app.ts`（临时添加）

在 `app.ts` 中注册临时端点 `POST /api/admin/migrate-templates`：

```typescript
// ══ TEMPORARY: Template migration endpoint (remove after migration) ══
app.post('/api/admin/migrate-templates', async (c) => {
  const user = c.var.currentUser;
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const atomic = stores.atomic;
  const idx = await atomic.get<string[]>('tpl:ids');
  if (!idx) return c.json({ migrated: 0, message: 'No templates to migrate' });

  const results: { id: string; before: string; after: string; success: boolean; error?: string }[] = [];

  for (const tid of idx.value) {
    try {
      const entry = await atomic.get<Record<string, unknown>>('tpl:' + tid);
      if (!entry) continue;

      const raw = entry.value;
      // 跳过已迁移的模板
      const kind = z.string().optional().parse(raw.kind);
      if (kind === 'Pod') continue;

      // 转换旧格式 → 新格式
      // 对于旧的 KV 数据，v1 Container 格式使用 legacy v1→core 转换
      // 对于 v2 ContainerGroup 格式使用 assembly→core 转换（assemblyToCorePodSpec 逻辑内联）
      let newSpec: Record<string, unknown>;

      if (kind === 'ContainerGroup') {
        // 内联 assemblyToCorePodSpec 逻辑
        const podSpecRaw = z.custom<Record<string, unknown>>().parse(raw.podSpec);
        newSpec = convertLegacyContainerGroup(podSpecRaw);
      } else {
        // 内联 v1 convertTemplateInput 逻辑
        newSpec = convertLegacyContainer(raw);
      }

      const migrated = {
        ...raw,
        kind: 'Pod',
        apiVersion: 'hbi-aad/v1',
        spec: newSpec,
        updatedAt: Date.now(),
        // 删除旧字段
        container: undefined,
        podSpec: undefined,
        healthChecks: undefined,
        network: undefined,
        extensions: undefined,
      };

      await atomic.set('tpl:' + tid, migrated, entry.version);
      results.push({ id: tid, before: kind ?? 'unknown', after: 'Pod', success: true });
    } catch (e: unknown) {
      results.push({ id: tid, before: 'unknown', after: 'Pod', success: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  return c.json({ migrated: succeeded, failed, total: results.length, results });
});
```

**两个内联转换函数**:

`convertLegacyContainer(raw)` — 处理 `kind=Container` 的旧格式：
- 提取 `containers` / `initContainers` → `spec.spec.containers[]`
- 提取 `healthChecks[]` → 分发到对应容器的 probe 字段
- 提取 `network.vpc` → `spec.providerOverrides.alibaba`
- 提取 `extensions.providerOverrides.alibaba` → `spec.providerOverrides.alibaba`
- 提取 `region` / `restartPolicy` → 对应位置
- 提取 `singleton` / `dependsOn` → Template 顶层

`convertLegacyContainerGroup(raw)` — 处理 `kind=ContainerGroup` 的旧格式：
- 内联当前 `assemblyToCorePodSpec` 的全部逻辑
- 输出 core PodSpec 形状

**验证**: 部署后 curl 触发迁移，确认所有 KV 模板转为新格式。

---

### B2. 清理迁移端点

迁移成功后，从 `app.ts` 中删除 `POST /api/admin/migrate-templates` 路由及其内联的转换函数。

---

## Phase C — 彻底清理

### C1. 删除 applicator.ts

```bash
git rm src/features/template/applicator.ts
```

### C2. 删除 assembly 目录

```bash
git rm src/features/template/assembly/types.ts
git rm src/features/template/assembly/index.ts
# 如果 assembly/ 已空则删除整个目录
```

### C3. 删除 assembly-to-core.ts

```bash
git rm src/features/template/assembly-to-core.ts
```

### C4. 清理 sandbox/types.ts — 删除 Sandbox 专属类型

**保留并已搬走的类型**（Phase A2 已搬到 `core/volume/types.ts`）从 `sandbox/types.ts` 中删除。

**直接删除的 Sandbox 专属类型**:
- `SandboxId`, `createSandboxId`
- `SandboxStatus` enum
- `TERMINAL_STATES`, `VALID_TRANSITIONS`, `DELETABLE_STATES`
- `isValidTransition`, `isTerminal`
- `Sandbox` interface
- `CreateSandboxInput`
- `SandboxNetworkConfig`
- `ContainerConfig`
- `InitContainerConfig`
- `ContainerStatus` enum
- `ContainerState` (sandbox 版)
- `ContainerRuntime` (sandbox 版)
- `ContainerEvent` (sandbox 版)
- `NetworkInfo` (sandbox 版)
- `ResourceSpec`
- `PodCondition` (sandbox 版)
- `ConditionStatus` (sandbox 版)
- `ProviderIdentity`

### C5. 清理 `core/events/health-check.ts`

**文件**: `src/core/events/health-check.ts`

该文件现有两套 GC 机制：
- 旧的 `registerHealthCheck` (L49-295) — 操作 `sandbox:ids` + `sandbox:XXX` 键
- 新的 `registerPodHealthCheck` (L404-576) — 操作 Pod 实体

**删除**: `registerHealthCheck` 函数及其所有辅助代码（`dispatchGc`, `gcUpdateState`, `GcParams`）。

**删除的 import**:
```typescript
- import type { Sandbox } from '../../features/sandbox/types.ts';
- import { SandboxStatus } from '../../features/sandbox/types.ts';
- import { runtimeToNetwork, runtimeToContainers, runtimeToEvents } from '../../features/sandbox/runtime-mapper.ts';
```

**保留**: `registerPodHealthCheck` 及其辅助代码（`dispatchPodGc`, `gcUpdatePodState`, `resolvePodGcInstanceId`, `PodGcParams`）。

**修改 `app.ts`**: 将 `registerHealthCheck` 调用替换为 `registerPodHealthCheck`：

```typescript
// app.ts — 将原有的 registerHealthCheck 调用改为:
import { registerPodHealthCheck } from './events/health-check.ts';
// ...
registerPodHealthCheck({
  podService,
  stores: { atomic: stores.atomic },
  providers: { resolveContainer: providers.resolveContainer.bind(providers) },
  eventBus,
  eventLoop,
  audit,
  queueProducer,
});
```

### C6. 清理 `queue/consumer.ts`

**文件**: `src/queue/consumer.ts`

当前 `handleSandboxGc` (L200-282) 直接操作 `sandbox:XXX` KV 键和 `SandboxStatus.Deleted`。

**改为**: 操作 `pod:XXX` KV 键和 `PodPhase.Failed`。

```typescript
async function handleSandboxGc(
  payload: SandboxGcPayload,
  instance: AppInstance,
): Promise<TaskResult> {
  // 改为操作 pod: + PodPhase
  const podEntry = await stores.atomic.get<PodEntity>('pod:' + payload.sandboxId);
  // ... 使用 PodPhase 替代 SandboxStatus
}
```

或者——如果 `registerPodHealthCheck` 中的 `dispatchPodGc` 已经处理了 Queue 路径——确认无调用点后直接删除 `handleSandboxGc`。

**删除的 import**:
```typescript
- import { SandboxStatus } from '../features/sandbox/types.ts';
```

### C7. 清理 `app.ts` 的 Sandbox 日志路由

**文件**: `src/core/app.ts`

L448-492 的 `GET /api/sandboxes/:id/logs` 直接使用 `Sandbox` 类型和 `createSandboxId`。

**替换为**: Pod 版本的日志端点（当前 `pod/handler.ts` 已有 `GET /:id/logs` 路由，走 `PodService.getLogs`），所以此路由可直接删除或标记 deprecated。

```bash
# 删除 app.ts 中的:
# - L20-21: Sandbox / createSandboxId import
# - L448-492: GET /api/sandboxes/:id/logs 路由
# - L496-521: GET /api/sandboxes/:id/logs/stream 路由（如 Pod 版本已存在）
```

### C8. 清理 `core/provider/container-lifecycle.ts`

**文件**: `src/core/provider/container-lifecycle.ts`

**删除**: `toSandboxStatus()` 和 `fromSandboxStatus()` 函数（L447-525），因为它们映射到不再使用的 `SandboxStatus`。

替换为与 `PodPhase` 的映射（若仍需使用）。实际上 `PodService.toPodPhase()` 已提供 `ContainerGroupState → PodPhase` 的映射，所以 Sandbox 桥接函数可以安全删除。

**删除的 import**:
```typescript
- import { SandboxStatus } from '../../features/sandbox/types.ts';
```

### C9. 删除 `sandbox/runtime-mapper.ts`

```bash
git rm src/features/sandbox/runtime-mapper.ts
```

所有功能已被 `PodService` 内联实现覆盖 (`toPodPhase`, `toContainers`, `buildContainerState`)。

### C10. 删除 `sandbox/base.ts`

```bash
git rm src/features/sandbox/base.ts
```

### C11. 清理 `sandbox/index.ts`

```bash
git rm src/features/sandbox/index.ts
```

### C12. 清理 `sandbox/types.ts` — 最终状态

此时 `sandbox/types.ts` 应只包含：
- Volume 相关类型 → 已搬走（从 `core/volume/types.ts` 导入）
- Sandbox 专属类型 → 已删除

如果 `sandbox/types.ts` 变为空文件或只剩 re-export，删除它。

### C13. 删除旧的测试文件

```bash
git rm tests/sandbox/assembly/resolver.test.ts
git rm tests/sandbox/types.test.ts
git rm tests/features/sandbox/logs-integration.test.ts
git rm tests/features/sandbox/provider-identity.test.ts
```

### C14. 更新 `src/index.ts` 的 LogStreamDO 导出

**文件**: `src/index.ts`

```typescript
// LogStreamDO 保留，因为它是一个 Durable Object，与 Sandbox 实体无关
export { LogStreamDO } from './features/sandbox/log-stream-do.ts';
```

注意：如果 `log-stream-do.ts` 引用了已删除的 sandbox 类型，需要更新 import。

---

## Phase D — 全量验证

```bash
npm run generate    # 重新生成 templates.generated.ts + generated.ts
npm run typecheck   # 必须零新增错误（361 个 podman/stub 预存错误可忽略）
npm run lint        # CEA 违规数应显著下降（z.custom 减少，as 断言减少）
npm test            # 全量通过
npm run map         # 确认无新死代码、无循环依赖
```

### 新增测试

- `tests/core/pod/merge.test.ts` — `mergePodSpec` 单元测试：容器按名合并、volume 合并、providerOverrides 合并、子覆盖父、父独有保留

---

## 依赖图

```
Phase 0 (前置检查)
  │
  ▼
A1 (gpuType) ────────────────────────────── 独立
A2 (core/volume/types.ts 搬家) ──────────── 独立
  │
  ├──→ A3 (mergePodSpec) ───────────────── 独立
  │
  ├──→ A4 (Template 类型精简) ◄── 依赖 A1
  │       │
  │       ├──→ A5 (重写 21 YAML) ────────── 独立（可提前做）
  │       ├──→ A6 (简化 fromGeneratedTemplate) ◄── 依赖 A4+A5
  │       ├──→ A7 (DAG 合并改用 mergePodSpec) ◄── 依赖 A3+A4
  │       ├──→ A8 (handler 修改) ◄── 依赖 A4+A6+A7
  │       └──→ A9 (index.ts 修改) ◄── 依赖 A8
  │
Phase A 完成 ◄──── 全部 A1-A9
  │
  ▼
Phase B (迁移端点 + 数据迁移)
  │
  ▼
Phase C (清理)
  │
  ├── C1-C13 可并行
  │
  ▼
Phase D (全量验证)
```

- A1, A2, A3, A5 可完全并行
- A4 依赖 A1（类型字段变更）
- A6-A9 依赖 A4（Template 类型变更后 handler 才能编译）
- Phase B 依赖 Phase A 全部完成
- Phase C 的各步骤可并行

---

## 风险与回滚

- **每 Phase 至少一个 commit**，关键文件（handler.ts, types.ts）更细粒度
- **Phase A 的 YAML 重写量最大** (21 文件)，建议先改 2-3 个简单模板验证 `fromGeneratedTemplate` 能正确解析，再批量改剩余
- **Phase B 的迁移端点**必须幂等（已迁移的模板跳过），且保留旧格式字段（`container`, `podSpec` 等设为 undefined）以便回滚
- **Phase C 删除 sandbox 类型前**必须 grep 确认无隐蔽引用
- `log-stream-do.ts` 保留，它与 Sandbox 实体无关，是 Durable Object

---

## 预计变更量

| Phase | 新增 | 删除 | 修改 |
|---|---|---|---|
| A1 — gpuType | 1 行 | 0 | 0 |
| A2 — Volume 搬家 | ~100 行 | 0 | ~30 行 (import 更新) |
| A3 — mergePodSpec | ~80 行 | 0 | 0 |
| A4 — Template 类型精简 | ~20 行 | ~80 行 | ~10 行 (response-schema) |
| A5 — YAML 重写 | ~200 行 | ~200 行 | 0 |
| A6 — fromGeneratedTemplate | ~25 行 | ~55 行 | 0 |
| A7 — DAG 合并 | ~5 行 | ~60 行 (deepMerge 系列) | ~10 行 |
| A8 — handler 修改 | ~30 行 | ~80 行 | ~20 行 |
| A9 — index.ts | 0 | ~5 行 | ~5 行 |
| B1 — 迁移端点 | ~130 行 (临时) | ~130 行 (执行后删) | 0 |
| C1-C13 — 清理 | 0 | ~1,000 行 | ~30 行 |
| **合计** | **~460 行** | **~1,480 行** | **~105 行** |

净减少约 1,125 行。
