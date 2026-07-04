# 模板系统精简：去 Sandbox 化

> **日期**: 2026-07-04
> **依赖**: Sandbox 实体已删除，Pod 已成为唯一聚合根
> **目标**: 消除模板系统中的 Sandbox 残留引用和命名债务

---

## 背景

SandboxService / SandboxStore / Sandbox 实体全部删除后，模板系统存在两类残留：

1. **运行时断裂** — `countRunningForTemplate` 查询 `sandbox:ids` 索引，但该索引已无数据写入，singleton/instanceLimit 静默失效
2. **命名债务** — `SandboxTemplate` 类型名、`sandbox-tpl:` 存储前缀、`SandboxStatus` 导入等

---

## 改动清单

### 1. `countRunningForTemplate` + `claimInstanceSlot` 改为查 Pod

**文件**: `src/features/template/handler.ts`

```diff
- const SANDBOX_INDEX_KEY = 'sandbox:ids';
- const SANDBOX_PREFIX = 'sandbox:';
+ const POD_INDEX_KEY = 'pod:ids';
+ const POD_PREFIX = 'pod:';

- const LIVE_STATUSES: string[] = [
-   SandboxStatus.Pending,
-   SandboxStatus.Scheduling,
-   SandboxStatus.Running,
-   SandboxStatus.Succeeded,
-   SandboxStatus.Terminating,
-   SandboxStatus.Restarting,
-   SandboxStatus.Updating,
- ];
+ // PodPhase: Pending/Running = active; Succeeded/Failed = terminal (can restart)
+ const LIVE_POD_PHASES = new Set(['Pending', 'Running']);
```

`countRunningForTemplate` 函数体:

```diff
- const idx = await atomic.get<string[]>(SANDBOX_INDEX_KEY);
+ const idx = await atomic.get<string[]>(POD_INDEX_KEY);
  if (!idx) return 0;
  let count = 0;
- for (const sid of idx.value) {
-   const entry = await atomic.get<Record<string, unknown>>(SANDBOX_PREFIX + sid);
-   if (entry?.value?.config?.templateRef === tplId && LIVE_STATUSES.includes(entry.value.status)) {
+ for (const pid of idx.value) {
+   const entry = await atomic.get<Record<string, unknown>>(POD_PREFIX + pid);
+   if (entry?.value?.templateRef === tplId && LIVE_POD_PHASES.has(entry.value.phase)) {
      count++;
    }
  }
```

`claimInstanceSlot` 中 perUser 限制的遍历（行 326-340 附近）：

```diff
- const idx = await atomic.get<string[]>(SANDBOX_INDEX_KEY);
+ const idx = await atomic.get<string[]>(POD_INDEX_KEY);
  let userCount = 0;
  if (idx) {
-   for (const sid of idx.value) {
-     const entry = await atomic.get<Record<string, unknown>>(SANDBOX_PREFIX + sid);
-     if (entry.value.config.templateRef === tpl.id
-         && LIVE_STATUSES.includes(entry.value.status)
-         && entry.value.config.creatorId === userId) {
+   for (const pid of idx.value) {
+     const entry = await atomic.get<Record<string, unknown>>(POD_PREFIX + pid);
+     if (entry.value.templateRef === tpl.id
+         && LIVE_POD_PHASES.has(entry.value.phase)
+         && entry.value.creatorId === userId) {
        userCount++;
      }
    }
  }
```

删除 import:
```diff
- import { SandboxStatus } from '../sandbox/types.ts';
```

---

### 2. 删除 deprecated 字段

**文件**: `src/features/template/types.ts` → `TemplateStorage`

```diff
- /** @deprecated 未使用，开发错误 */
- readonly hostPath?: { path: string } | undefined;
- /** @deprecated 使用 securityRefs 替代 */
- readonly securityRef?: string | undefined;
- /** @deprecated 使用 containerSecretRefs 替代 */
- readonly secretRef?: string | undefined;
```

确认 `applicator.ts` 的 `mapStorage` 中没有引用 `hostPath`、`securityRef`（旧）、`secretRef`（旧）。只使用 `securityRefs` 和 `containerSecretRefs`。

---

### 3. `SandboxTemplate` → `Template`

**文件**: `src/features/template/types.ts`

```diff
- export interface SandboxTemplate {
+ export interface Template {
```

`CreateTemplateInput` / `UpdateTemplateInput` 中的注释保持不动（它们引用的是自身的 `container`/`podSpec` 字段，与 Sandbox 无关）。

**文件**: `src/features/template/handler.ts`

所有函数签名和变量中 `SandboxTemplate` → `Template`，包括：
- `fromGeneratedTemplate` 返回类型
- `resolveTemplateSource` 参数/返回类型
- `ResolvedTemplate` 接口
- `listAllLive` 返回类型
- `resolveDag` 参数/返回类型
- `resolveTemplate` / `resolveTemplateWithChain` 返回类型
- `listStored` 返回类型
- `canAccessTemplate` 参数类型
- `claimInstanceSlot` / `releaseInstanceSlot` 参数类型
- `claimResourceBinding` / `releaseResourceBinding` 参数类型
- `resolveTemplate` 导出

更新 import:
```diff
- import type { SandboxTemplate, CreateTemplateInput, UpdateTemplateInput, ContainerSpec, ContainerDef, HealthCheckDef, TemplateInstanceLimit } from './types.ts';
+ import type { Template, CreateTemplateInput, UpdateTemplateInput, ContainerSpec, ContainerDef, HealthCheckDef, TemplateInstanceLimit } from './types.ts';
```

**文件**: `src/features/template/applicator.ts`

```diff
- import type { SandboxTemplate, ContainerSpec, ContainerDef, HealthCheckDef, TemplateStorage } from './types.ts';
+ import type { Template, ContainerSpec, ContainerDef, HealthCheckDef, TemplateStorage } from './types.ts';

- export async function applyTemplate(tpl: SandboxTemplate, ...): Promise<{ podSpec: PodSpec; securityRefNames: string[] }> {
+ export async function applyTemplate(tpl: Template, ...): Promise<{ podSpec: PodSpec; securityRefNames: string[] }> {
```

**文件**: `src/features/template/response-schema.ts`

```diff
- export const SandboxTemplateSchema = z.object({
+ export const TemplateSchema = z.object({
```

handler.ts 中更新引用:
```diff
- import { SandboxTemplateSchema, ResolvedTemplateSchema, TemplateDeleteResponseSchema } from './response-schema.ts';
+ import { TemplateSchema, ResolvedTemplateSchema, TemplateDeleteResponseSchema } from './response-schema.ts';
```

更新 schema 使用的路由中的引用（`SandboxTemplateSchema` → `TemplateSchema`）。

---

### 4. 存储前缀 `sandbox-tpl:` → `tpl:`

**文件**: `src/features/template/handler.ts`

```diff
- const PREFIX = 'sandbox-tpl:';
- const INDEX_KEY = 'sandbox-tpl:ids';
+ const PREFIX = 'tpl:';
+ const INDEX_KEY = 'tpl:ids';
```

---

## 不变内容

以下**不需要**改：

| 项目 | 原因 |
|---|---|
| `kind: 'Container' \| 'ContainerGroup'` | 区分 v1 平铺格式和 v2 docker-compose 格式，两种都支持 |
| `ContainerSpec` / `ContainerDef` | 模板中间表示，与 Sandbox 无关 |
| `HealthCheckDef` / `NetworkSpec` / `TemplateStorage` | 同上 |
| `TemplateVisibility` / `TemplateInstanceLimit` / `TemplateResourceBinding` | 模板治理原语，不依赖 Sandbox |
| `applicator.ts` 的 `mapStorage` / `buildProbeMap` | 映射到 core PodSpec，逻辑不变 |
| `deepMerge` / `resolveDag` / DAG 解析 | 纯模板操作，不碰实体 |
| `lockKey` / `bindingKey` | 使用 `tpl:` 前缀，已是正确命名 |
| `assembly-to-core.ts` | 已正确，不依赖 Sandbox |

---

## 验证

```bash
npm run typecheck   # 必须零新增错误
npm run lint        # 必须通过
```

---

## 预计变更

| 类型 | 大约行数 |
|---|---|
| handler.ts 修改 | ~30 行 |
| types.ts 修改 | ~10 行 |
| applicator.ts 修改 | ~3 行 |
| response-schema.ts 修改 | ~3 行 |
| **合计** | **~46 行** |
