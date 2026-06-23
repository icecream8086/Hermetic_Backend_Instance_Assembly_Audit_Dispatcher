# 代码审视报告

> 2026-06-24 | 256 源文件 | 2883 函数/方法 | 95 类 | 0 循环依赖

## 审视维度

1. 安全性（CORS/CSP/认证/密钥管理）
2. 错误处理（静默吞错 / 空 catch / 类型安全）
3. 代码质量（重复 / 幻数 / 未使用代码）
4. 架构一致性（DI 入口 / 配置抽象 / 桶导入规则）
5. 运维安全（限速 / 幂等 / 启动顺序）

---

## 一、HIGH — 已修复

### 1.1 CORS 通配符 `origin: "*"`

**文件** `src/core/app.ts:194`

```typescript
// 修复前：任意来源可跨域
app.use('*', cors());

// 修复后：仅允许配置的来源
app.use('*', cors({
  origin: config.cors?.origins ?? ['http://localhost:8086'],
  credentials: true,
}));
```

`config.cors.origins` 由 `.env` 的 `CORS_ORIGINS` 加载（`src/config/env.ts:151`），之前未被传入 `cors()`，导致 Hono 默认 `origin: "*"`。任意网站可跨域调用 API。

### 1.2 幂等中间件已实现但未挂载

**文件** `src/core/middleware/idempotency.ts` → `src/core/app.ts:224`

完整的幂等中间件（读取 `Idempotency-Key` 头 → 检查存储 → 返回缓存响应 / 执行并缓存）已实现，但在 `createApp()` 中从未注册。所有变异端点（POST/PUT/DELETE）均无重放保护。

**修复**：在 context injection 之后挂载 `app.use('*', idempotency())`。挂载顺序：

```
secureHeaders → cors → bodyLimit → jsonDepthLimit → rateLimit
→ onError → context injection → idempotency → authz → routes
```

注意：必须放在 context injection **之后**，因为中间件依赖 `c.var.stores.atomic`。

### 1.3 关键初始化路径中的悬浮 Promise

**文件** `src/core/app.ts:148`

```typescript
// 修复前：Promise 未 await，createApp() 可能在日志策略就绪前返回
stores.atomic.get<any>('_sys:log-policy').then(entry => {
  if (entry) setActivePolicy(entry.value);
}).catch(...)

// 修复后：await，确保策略在首次请求前应用
const policyEntry = await stores.atomic.get<any>('_sys:log-policy');
if (policyEntry) setActivePolicy(policyEntry.value);
```

### 1.4 空 catch 块（唯一缺少注释的）

**文件** `src/features/network/service.ts:120`

```typescript
// 修复前
try { await this.networkPolicy.removeNetwork(...); } catch { }

// 修复后
try { await this.networkPolicy.removeNetwork(...); } catch { /* best-effort — provider network may already be gone */ }
```

代码库中有 ~15 个 `.catch(() => {})` / `catch { }`，除此处外均有注释说明为何静默。

---

## 二、MED — 已修复

### 2.1 限速关闭无启动警告

**文件** `src/core/app.ts:209`

```typescript
if (config.rateLimit?.enabled === false) {
  console.warn('[app] RATE LIMITING DISABLED — not suitable for production');
}
```

---

## 三、MED — 待处理

### 3.1 `catch (e: any)` — 约 25 处

| 文件 | 数量 |
|------|------|
| `features/sandbox/handler.ts` | 10 |
| `features/topology/handler.ts` | 6 |
| `features/subnet/handler.ts` | 3 |
| `features/template/handler.ts` | 2 |
| `features/actions/handler.ts` | 2 |
| 其他 | 2 |

TypeScript 5.x 的 `useUnknownInCatchVariables` 下，`catch (e: any)` 绕过了类型安全。

**建议修复**：
```typescript
// 改前
} catch (e: any) {
  return c.json(fail('XXX_FAILED', e.message), 500);
}

// 改后
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return c.json(fail('XXX_FAILED', msg), 500);
}
```

### 3.2 散落的 `process.env` 读取（绕过配置抽象）

`loadConfig()` 是唯一的配置入口，但以下文件直接读 `process.env`：

| 文件 | 变量 |
|------|------|
| `core/provider/factory.ts:98,310,366` | `PODMAN_ENDPOINT` |
| `core/provider/instance-resolver.ts:134-135` | `ALIBABA_ACCESS_KEY_ID/SECRET` |
| `core/region/scheduler.ts:127` | `PODMAN_ENDPOINT` |
| `core/seed.ts:165` | `PODMAN_ENDPOINT` |
| `core/auth/secret-encryption.ts:19` | `SECRET_MASTER_KEY` |
| `core/logger/log-policy.ts:16-17` | `LOG_LEVEL`, `NODE_ENV` |
| `features/topology/index.ts:19-29` | `S3_BACKEND`, `S3_ACCESS_KEY_ID` 等 |
| `features/info/info.handler.ts:19` | `CF_REGION` |
| `providers/podman/podman-image.ts:3` | `PODMAN_ENDPOINT` |

**建议**：全部通过 `loadConfig()` → `AppConfig` 传递，使配置可审计。

### 3.3 `SECRET_MASTER_KEY` 未设置时凭证明文存储

**文件** `src/core/auth/secret-encryption.ts:19-20`

```typescript
const key = process.env[SecretEncryption.ENV_KEY];
if (!key) return undefined; // 降级为明文
```

**建议**：在 `src/index.ts`（生产入口）启动时检查，未设置则 `throw`。`src/dev.ts` 可继续允许明文。

### 3.4 计数器 `.catch(() => {})` 静默吞错

**文件** `src/features/system-group/service.ts:48,142`

`incrCounter()` / `decrCounter()` 失败被静默丢弃。计数器用于配额和统计，失败时应至少 log。

---

## 四、LOW — 已知，不修

### 4.1 `as any` 类型绕过 — 188 处，42 文件

| 文件 (Top 5) | 数量 |
|-------------|------|
| `features/actions/handler.ts` | 27 |
| `features/sandbox/sandbox.service.ts` | 14 |
| `features/template/applicator.ts` | 13 |
| `features/actions/runner.ts` | 11 |
| `providers/podman/podman-provider.ts` | 10 |

**不修理由**：分散面太广，需逐文件审计。当前 `strict: true` 已开启，`as any` 是显式妥协。建议在新代码中禁止，旧代码随需清理。

### 4.2 非空断言 `!.` — 50+ 处

集中出现在 `filter(Boolean).map(e => e!.value)` 模式（~30 处）和 `this.#store!` 懒初始化模式。语义安全但在运行时无保护。

**不修理由**：可引入 `compactMap` 工具函数一次性消除，但非紧急。

### 4.3 未使用导出 — ~340 个（knip）

**值得注意的**：

| 导出 | 文件 | 说明 |
|------|------|------|
| `SandboxMetricsService` | `sandbox.service.ts:537` | 完整实现但从未实例化 |
| `SandboxLogService` | `sandbox.service.ts:558` | 同上 |
| `createLogId`, `createOrderId` | `core/brand.ts` | 品牌工厂未使用 |
| `SYSTEM_FACILITY` | `core/app.ts:437` | 导出但未导入，审计链路断开 |
| `percentEncode`, `hmacSha1Base64` | `core/auth/providers.ts` | 认证辅助函数未使用 |
| `generateCredentialId` | `core/auth/credential.ts:15` | 品牌工厂未使用 |
| `CloudflareLogReader` | `providers/cloudflare/log-reader.ts` | 整个文件未导入 |

### 4.4 幻数

| 值 | 出现次数 | 含义 | 建议常量名 |
|----|---------|------|-----------|
| `http://127.0.0.1:8080` | 9 | Podman 默认端点 | `DEFAULT_PODMAN_ENDPOINT` |
| `30 * 60 * 1000` | 4 | 30 分钟 | `SUDO_GRACE_MS` |
| `24 * 60 * 60 * 1000` | 4 | 24 小时 | `KEY_ROTATION_MS` |
| `1000` | 2 | 默认优先级 | `DEFAULT_ACL_PRIORITY` |
| `30000` / `60000` | 5 | 调度/事件循环间隔 | `DEFAULT_TICK_MS` |

### 4.5 品牌 ID 工厂重复 — ~16 个函数

`create*Id` / `generate*Id` 模式在 8 个文件中重复。可用 `BrandedId<T>` 泛型工厂统一。

### 4.6 CSP / Permissions-Policy 未配置

`secureHeaders()` 使用 Hono 默认值，未设置 `Content-Security-Policy` 和 `Permissions-Policy`。对 API 后端影响有限（不返回 HTML），但建议显式设置 `default-src 'none'`。

---

## 五、项目亮点（做得好的地方）

| 项目 | 说明 |
|------|------|
| 0 循环依赖 | `madge` 检测通过，barrel 导入规则严格执行 |
| 错误不泄露堆栈 | `error-handler.ts` 返回通用 `INTERNAL_ERROR`，堆栈仅写 console |
| 0 FIXME / HACK | 仅 2 个 TODO 在 OSS 分页功能 |
| 安全头 | 7 个安全头已配置（X-Content-Type-Options, X-Frame-Options, HSTS 等） |
| 桶导入规则遵守 | `providers/` 文件全部直接 import `interfaces.ts` + `types.ts`，无 barrel 违规 |
| 幂等中间件设计 | 完整的实现（仅缺挂载），支持 Idempotency-Key + 响应缓存 + 重放检测 |
| 审计系统分离 | `IAuditWriter` / `IAuditReader` / `IAuditAdmin` 接口分离，多后端支持 |

---

## 六、修复汇总

| 修复 | 严重度 | 状态 |
|------|--------|------|
| CORS 通配符 → 受限来源 | HIGH | ✅ 已修 |
| 幂等中间件挂载 | HIGH | ✅ 已修 |
| 日志策略悬浮 Promise | HIGH | ✅ 已修 |
| 空 catch 块注释 | HIGH | ✅ 已修 |
| 限速关闭启动警告 | MED | ✅ 已修 |
| `catch (e: any)` → `catch (e: unknown)` | MED | ⏳ 待处理 |
| `process.env` 分散读取 | MED | ⏳ 待处理 |
| 凭证明文存储保护 | MED | ⏳ 待处理 |
| 计数器静默吞错 | MED | ⏳ 待处理 |
| 188 `as any` | LOW | 已知不修 |
| 50+ `!.` | LOW | 已知不修 |
| ~340 未使用导出 | LOW | 已知不修 |
| 9 处 Podman 端点硬编码 | LOW | 已知不修 |
