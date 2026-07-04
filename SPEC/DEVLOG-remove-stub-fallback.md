# 移除 Stub 静默降级 + 删除全局 Provider 选择

> **日期**: 2026-07-04
> **依赖**: 无（独立修改）
> **目标**: 删除 `PROVIDER_CONTAINER` 环境变量和 `StubContainerProvider` 静默降级——Provider 选择 100% 基于 ComputeInstance 实体

---

## 问题

```
PodService.resolveProvider()
  → InstanceProviderResolver.resolveContainer(undefined)
    → instanceService.resolveByCapability('container')
    → []  (没有注册的计算实例)
    → return new StubContainerProvider()   ← 静默降级!
    → provider.create() → 返回假 providerId
    → HTTP 201 → 用户以为成功了 → 什么都没创建
    → Pod GC 扫到假 pod → OCC 冲突 → 刷屏
```

## 原则

没有注册实例 → 就该报错。Provider 选择 100% 基于 ComputeInstance 实体，不存在"全局默认"。

---

## 变更清单

| # | 文件 | 操作 |
|---|---|---|
| 1 | `src/config/schema.ts` | `ProviderConfigSchema` 删 `container` 字段 |
| 2 | `src/config/env.ts` | 删 `PROVIDER_CONTAINER` env 读取行 |
| 3 | `.env` | 删 `PROVIDER_CONTAINER=podman` 行 |
| 4 | `src/core/provider/instance-resolver.ts:48-57` | 无实例时 throw 清晰错误 |
| 5 | `src/core/provider/instance-resolver.ts:32` | 删 unused `StubContainerProvider` import |
| 6 | `src/core/provider/factory.ts:283-299` | `_resolveDefaultEntry()` 不再创建 Stub container |
| 7 | `src/core/provider/factory.ts:30` | 删 unused `StubContainerProvider` import |

---

## Step 1 — 删 `config/schema.ts` 的 `container` 字段

**文件**: `src/config/schema.ts:38-46`

```diff
 const ProviderConfigSchema = z.object({
-  container: z.enum(['alibaba', 'podman', 'stub']).default('stub'),
   region: z.string().default('cn-hangzhou'),
   accounts: z.array(CredentialSchema).default([]),
   defaultAccount: z.string().default('default'),
   cfApiToken: z.string().optional(),
   dns: z.enum(['cloudflare', 'stub']).default('stub'),
   metrics: z.enum(['alibaba', 'stub']).default('stub'),
 });
```

---

## Step 2 — 删 `config/env.ts` 的 `PROVIDER_CONTAINER` 读取

**文件**: `src/config/env.ts:98`

```diff
-   container: process.env.PROVIDER_CONTAINER ?? 'stub',
```

---

## Step 3 — 删 `.env` 的 `PROVIDER_CONTAINER`

```diff
- # ─── Provider ───
- # 'alibaba' = 阿里云 ECI, 'podman' = 本地 Podman, 'stub' = 模拟
- PROVIDER_CONTAINER=podman
```

---

## Step 4 — `resolveContainer(undefined)` 无实例时 throw

**文件**: `src/core/provider/instance-resolver.ts:48-57`

```typescript
public async resolveContainer(instanceId?: InstanceId): Promise<IContainerProvider> {
  if (instanceId) {
    const inst = await this.instanceService.get(instanceId);
    if (inst) return this.#createContainerProvider(inst);
    throw new AppError(404, 'INSTANCE_NOT_FOUND', `Container instance ${instanceId} not found`);
  }
  const all = await this.instanceService.resolveByCapability('container');
  if (all.length > 0) return this.#createContainerProvider(all[0]!);
  // ── 不再静默降级 ──
  throw new AppError(503, 'NO_CONTAINER_INSTANCE',
    'No online container-capable compute instance is registered. ' +
    'Create one via POST /api/instances with platform="alibaba" and capabilities=["container"].');
}
```

---

## Step 5 — 删 `instance-resolver.ts` 的 Stub import

**文件**: `src/core/provider/instance-resolver.ts:32`

```diff
- import { StubContainerProvider } from '../../providers/stub/container.ts';
```

确认 `StubContainerProvider` 在文件中无其他引用后再删。

> **实际结果：不能删。** `StubContainerProvider` 仍在 `#createContainerProvider()` 中用于 `'aws'` 和 `'stub'` platform 分支。这是合法路径——通过 `instanceId` 查到 platform=`'stub'` 的 ComputeInstance 时仍需创建 StubContainerProvider。import 保留。

---

## Step 6 — `factory.ts` 的 `_resolveDefaultEntry()` 不再创建 Stub container

**文件**: `src/core/provider/factory.ts:283-299`

```typescript
private _resolveDefaultEntry(): ProviderEntry {
  if (this._isAlibaba) {
    return this._buildAlibabaDefaultEntry();
  }
  if (this.config.container === 'podman') {
    return this._buildPodmanEntry();
  }
  return this._buildStubEntry();  // ← 保留 image/dns/metrics 的 Stub fallback
}
```

`_buildStubEntry()` 本身保留——但 `container` getter (L89-95) 已经 throw 了，删掉 `this.config.container` 的判断路径即可。`this._isAlibaba` 走 Alibaba 默认，否则走 Podman/Stub。**container 字段删后，`this.config.container` 不再存在**——把这段改为：

```typescript
private _resolveDefaultEntry(): ProviderEntry {
  if (this._isAlibaba) {
    return this._buildAlibabaDefaultEntry();
  }
  // Stub fallback for image/dns/metrics only; container getter throws
  return this._buildStubEntry();
}
```

---

## Step 7 — 删 `factory.ts` 的 Stub import

**文件**: `src/core/provider/factory.ts:30`

```diff
- import { StubContainerProvider } from '../../providers/stub/container.ts';
```

确认后删除。

> **实际结果：不能删。** `StubContainerProvider` 仍在 `_buildStubEntry()` 中用于创建 stub 容器的兜底返回。该函数保留（为 image/dns/metrics 提供 stub fallback），且 `ProviderEntry` 的 `container` 字段为非可选。import 保留。

---

## 验证

```bash
npm run typecheck   # 必须通过
npm run lint

# 删 .data/ 清空实例缓存，重启 wrangler dev
# 尝试 POST /api/templates/vsftp_GPU/apply
# → 预期: 503 { code: "NO_CONTAINER_INSTANCE" }

# 注册实例:
curl -X POST http://localhost:8787/api/instances \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "eci-hangzhou",
    "platform": "alibaba",
    "region": "cn-hangzhou",
    "endpoint": "eci.cn-hangzhou.aliyuncs.com",
    "credentialRef": "eci_profile@1890666018406380.onaliyun.com",
    "capabilities": ["container"]
  }'

# 再试 apply → 预期: 201 (真正创建 ECI 容器)
```
