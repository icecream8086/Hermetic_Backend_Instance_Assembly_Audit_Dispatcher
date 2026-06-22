# Provider 解析与错误处理重构计划

> 2026-06-23

## 问题诊断

当前 provider 层存在三个结构性缺陷：

### 1. 静默回退（Silent Fallback）

```
#resolveProvider(instanceId)
  → providerRegistry.resolveContainer(instanceId) ← 可能失败
  → 返回 null / 抛异常
  → 静默回退到 this.containerProvider (Podman)
  → 阿里云 ECI 沙箱被 Podman 接管 → 删除失败 / 同步挂死
```

### 2. 错误被吞

| 位置 | 代码 | 后果 |
|------|------|------|
| `sandbox.service.ts:terminate()` | `try { ... } catch { /* empty */ }` | ECI 删除失败无感知 |
| `consumer.ts:handleSandboxGc()` | `.catch(() => {})` | GC 重试无效 |
| `instance-resolver.ts:#resolveCredential()` | `return { ak: undefined, sk: undefined }` | 凭证为空不报错，等 ECI API 拒绝才暴露 |
| `template/handler.ts:apply` | `catch { releaseSlot... }` | fail 不区分原因 |

### 3. Provider 身份不持久化

沙箱的 `config` 字段不包含创建时使用的 provider 身份。后续 sync/delete/health 操作依赖 `#resolveProvider(instanceId)` 重新解析——但 `instanceId` 可能未存入、实例已离线、或 credential 已失效。

## 设计方案

### 核心原则

1. **永不静默回退** — 解析失败时抛出明确错误，不 fallback
2. **Provider 身份持久化** — 沙箱记录创建时的 provider 标识，后续操作直接复用
3. **错误分层** — 每一层有明确的错误类型和传播职责

### 新增数据结构

```typescript
// ── Provider 身份（持久化到沙箱 config） ──

interface ProviderIdentity {
  /** Provider 类型：podman | alibaba | aws | stub */
  readonly platform: string;
  /** 计算实例 ID（用于凭证解析） */
  readonly instanceId?: string;
  /** 实例 region（用于 ECI/OSS API 调用） */
  readonly region?: string;
  /** 实例 zone（用于多可用区） */
  readonly zoneId?: string;
  /** 创建时使用的 credential 引用 */
  readonly credentialRef?: string;
}

// ── 分层错误类型 ──

class ProviderResolutionError extends AppError {
  constructor(
    message: string,
    public readonly instanceId?: string,
    public readonly platform?: string,
  ) {
    super(503, 'PROVIDER_RESOLUTION_FAILED', message);
  }
}

class ProviderOperationError extends AppError {
  constructor(
    message: string,
    public readonly operation: string,  // 'create' | 'delete' | 'describe' | 'getLogs'
    public readonly providerId?: string,
    public readonly providerPlatform?: string,
  ) {
    super(502, 'PROVIDER_OPERATION_FAILED', message);
  }
}

class CredentialResolutionError extends AppError {
  constructor(
    message: string,
    public readonly credentialRef?: string,
    public readonly instanceId?: string,
  ) {
    super(401, 'CREDENTIAL_RESOLUTION_FAILED', message);
  }
}
```

### 修改清单

#### Phase 1: 消除静默回退

| 文件 | 位置 | 改前 | 改后 |
|------|------|------|------|
| `sandbox.service.ts` | `#resolveProvider()` | `return this.containerProvider` (回退) | `throw new ProviderResolutionError(...)` |
| `sandbox.service.ts` | `terminate()` | `catch { /* empty */ }` | `catch → throw ProviderOperationError` |
| `sandbox.service.ts` | `provision()` | `try { provider.create() } catch { throw e }` | `throw new ProviderOperationError(e)` |
| `sandbox.service.ts` | `syncRuntime()` | `throw AppError(404)` | 区分 not-found vs provider-error |
| `instance-resolver.ts` | `#resolveCredential()` | `return { ak: undefined }` | `throw CredentialResolutionError(...)` |
| `instance-resolver.ts` | `resolveContainer()` | instance not found → `throw AppError(404)` | 保持，加上 instanceId 上下文 |

#### Phase 2: Provider 身份持久化

| 文件 | 修改 |
|------|------|
| `sandbox.service.ts` | `provision()` 在沙箱 config 中写入 `ProviderIdentity` |
| `sandbox.service.ts` | `syncRuntime()` / `getHealth()` 直接从 config 读取，不重新解析 |
| `sandbox.service.ts` | `terminate()` 直接从 config 读取，不重新解析 |
| `template/handler.ts` | 所有临时创建的 `SandboxService` 必须传入 `providerRegistry` |
| `app.ts` | `LogStream` 端点直接从 config 读取 provider，不重复解析 |

#### Phase 3: 错误传播链

```
Handler → Service → Provider
   │         │          │
   ▼         ▼          ▼
AppError  Provider    Alibaba API Error
(400/404) Operation   → ProviderOperationError
          Error        → 502 Bad Gateway
          (502)
          
CredentialResolutionError
  → 401 或明确提示"实例 {id} 的凭证 {ref} 不可用"
```

## 实施优先级

| Phase | 文件数 | 风险 | 预计时间 |
|-------|--------|------|----------|
| Phase 1: 消除静默回退 | 4 | 中（破坏性变更——之前靠回退"工作"的路径现在会报错） | 1-2h |
| Phase 2: 身份持久化 | 3 | 低（纯增量） | 1h |
| Phase 3: 错误传播 | 2 | 低 | 30min |

## 验证

```
npm run typecheck
npx vitest run tests/features/sandbox/
npx vitest run tests/core/provider/
```

预期：所有现有测试通过，新增错误路径的测试覆盖。

## 不做什么

- 不改 ECI API 签名（RPC vs OpenAPI）
- 不改 Miniflare 代理超时
- 不在本次引入 RetryPolicy / CircuitBreaker（P2）
