# 微服务拆分解耦分析

> 日期: 2026-06-09
> 工具: depcruise + madge + metrics.ts + callgraph.ts + knip
> 前提: 20k 行 TypeScript, 12 feature 切片, 78 个有方法类

## 一、当前架构形态

```
                     app.ts (出度 95, 入度 3)
                   ┌── DI 容器 ───────────┐
                   │  createApp()          │
                   │  FeatureDeps          │
                   │  createStores()       │
                   │  createProviderReg()  │
                   │  EventBus + EventLoop │
                   │  health:check         │
                   └──┬──────┬──────┬──────┘
                      │      │      │
            ┌─────────┘      │      └─────────┐
            ▼                ▼                ▼
     generated.ts      middleware/      feature routers
     (12 features)     auth.ts         (12 × createXxxRouter)
            │          rate-limit.ts
            ▼
     feature/index.ts → handler.ts → FeatureDeps (import from app.ts)
```

**核心特征**: 星形拓扑。app.ts 是唯一枢纽，所有 feature 通过 `FeatureDeps` 反向依赖它。

## 二、25 个循环依赖 — 根因分析

madge 输出 25 个循环，全部遵循同一个模式：

```
app.ts → generated.ts → features/xxx/index.ts → features/xxx/handler.ts → import { FeatureDeps } from '../../core/app.ts'
```

这不是代码错误——是 TypeScript 的 DI 模式固有问题。`FeatureDeps` 类型定义在 `app.ts`，但 `app.ts` 通过 `generated.ts` 导入 feature 的 `createRouter`，而 `createRouter` 的签名依赖 `FeatureDeps`。

**修复方案**：将 `FeatureDeps` 和 `AppContext` 提取到独立文件 `src/core/types.ts`，打破类型级循环。不涉及运行时改动。

## 三、上帝类 Top 5

| 类 | 方法数 | LCOM | RFC | CBO | 问题 |
|---|---|---|---|---|---|
| PermissionService | 49 | 0.93 | 115 | 19 | 已拆为 4 manager，外观仍胖 |
| LazyProviderRegistry | 18 | 0.91 | 42 | 23 | CBO 最高，import 了 23 个模块 |
| SandboxService | 12 | 0.50 | 66 | 20 | RFC 高，provision 单方法调用 27 个不同函数 |
| UserService | 21 | 0.15 | 96 | 10 | 方法多但内聚好 (LCOM 0.15)，可接受 |
| GroupManager | 16 | 0.51 | 41 | 12 | 中等，尚可 |

**结论**: PermissionService 和 LazyProviderRegistry 是唯二需要继续拆的。其他的 LCOM 和 CBO 在合理范围。

## 四、微服务拆分瓶颈 — 按严重程度排序

### 🔴 瓶颈 1: IAtomicStore 作为集成数据库

```
this.atomic.get  ← 入度 110 (系统最高)
this.atomic.set  ← 入度 73

this.atomic.set ↔ this.atomic.get 共享 63 个 caller:
  CredentialService + BucketService + ImageRepositoryService +
  InstanceService + S3PolicyManager + ContainerSecretService +
  DnsService + SecurityGroupService + PermissionService +
  SandboxService + SubnetService + SysGroupService + UserService + ...
```

**这就是"集成数据库"反模式**。所有服务通过同一个 key space 通信，数据边界不存在。拆微服务的第一步不是拆代码，是**定义数据边界**——哪些 key 属于哪个服务。

当前 key space 分布：

| Key 前缀 | 归属 | 可能独立 |
|----------|------|---------|
| `sandbox:*`, `sandbox:ids`, `health:fails:*` | sandbox | ✅ |
| `user:*`, `user:email:*`, `user:idx:*`, `user:count`, `session:*` | users | ✅ |
| `permission:*`, `policy:*`, `group:*`, `routeacl:*`, `sysgroup:*`, `usergroup:*`, `permgroup:*` | permission | ✅ |
| `template:*`, `sandbox-tpl:*` | template | ⚠️ 依赖 sandbox |
| `instance:*`, `instance:ids` | topology | ✅ |
| `bucket:*`, `bucket-key:*`, `s3-policy:*` | topology/S3 | ✅ |
| `cred:*`, `cred:ids` | topology/credential | ⚠️ 被 sandbox 引用 |
| `volume:*`, `volume:ids` | volume | ✅ |
| `container-secret:*` | container-secret | ✅ |
| `dns:*` | dns | ✅ |
| `network:*`, `subnet:*` | network/subnet | ✅ |
| `image:*`, `pull-task:*` | topology/image | ✅ |
| `audit:*` | audit | ✅ |
| `events:pending` | event-bus | ✅ |
| `_sys:log-policy`, `_init:*` | system | ✅ |

**可提取的独立数据边界: 10+ 个**。但如果各自独立 store，跨服务查询（如 "某用户创建的所有沙箱"）需要 API 调用而不是 KV 读。

### 🔴 瓶颈 2: app.ts 作为单体 DI 容器

```
createApp() 出度 = 95, 入度 = 3
```

`createApp()` 是事实上的 `main()`。它：
- 创建 stores
- 创建 providers
- 创建 EventBus + EventLoop
- 注册 health:check + image.pull handler
- 创建 middleware 栈
- 注入 FeatureDeps 到 12 个 feature
- 挂载所有路由

拆出任何一个 feature 需要：
1. 复制该 feature 的 store 创建逻辑
2. 复制该 feature 需要的 provider 引用
3. 复制 FeatureDeps 中该 feature 实际使用的字段
4. 在新服务中重建 Hono app + middleware

**没有 IoC 容器，没有服务注册表**。当前是手工 DI——`createApp()` 里硬编码了全量初始化顺序。

### 🟡 瓶颈 3: PermissionService 横切

```
authz 中间件 → PermissionService.check → group-manager + policy-manager + route-acl-manager + perm-checker
```

每个 API 请求都走 `authz()` 中间件 → `PermissionService.checkRouteAccess()`。如果权限系统独立为服务，每个请求需要一次跨服务调用。**延迟敏感的拆不动**。

解决方案：
1. JWT 内嵌权限 claim（无状态验证，不需要查服务）
2. 或权限服务保持共享（不拆，各服务 import 同一个权限库）
3. 或 API Gateway 层面统一鉴权（Cloudflare Access / Zero Trust）

### 🟡 瓶颈 4: FeatureDeps 类型循环

```
app.ts → generated.ts → feature/index.ts → feature/handler.ts → FeatureDeps (from app.ts)
```

所有 12 个 handler 都 import `FeatureDeps` from `../../core/app.ts`。这意味：
- 你无法把 `features/sandbox/` 独立为一个 npm 包或独立 Worker
- 你无法在没有 `core/app.ts` 的环境中 import handler

**修复（低风险）**: 把 `FeatureDeps`、`AppContext`、`AppInstance` 提取到 `src/core/deps.ts`。app.ts 和所有 handler 都 import 新文件。循环消失。

### 🟢 瓶颈 5: Handler CRUD 模式重复

```
容斥分析:
  createSysGroupRouter ∩ createVolumeRouter = 19 个共享 callee
  createSecurityGroupRouter ∩ createVolumeRouter = 16 个共享 callee
```

每个 feature handler 都是同样的 CRUD 模式：
```
router.get → svc.list → c.json(ok(...))
router.post → schema.safeParse → svc.create → c.json(ok(...))
router.get('/:id') → svc.get → c.json(ok(...))
router.put('/:id') → schema.safeParse → svc.update → c.json(ok(...))
router.delete('/:id') → svc.delete → c.json(ok(...))
```

callgraph 显示 5 对 handler 共享 16-19 个 callee。可以抽取 `createCrudRouter()` 工厂函数消除重复，但目前不影响拆微服务。

### 🟢 瓶颈 6: health:check 单体扫描

```
health:check handler:
  scan sandbox:ids → enqueue GC
  scan instance:ids → heartbeat timeout
  scan bucket-key:ids → enqueue rotate
```

Queue 迁移后 tick 只扫描不入队，已经很轻量。但如果 sandbox 服务和 topology 服务分开，各自的健康检查应该独立运行。

## 五、拆微服务可行性矩阵

| Feature | 数据独立 | 无跨服务读 | 可独立部署 | 拆分难度 | 建议 |
|---------|---------|-----------|-----------|---------|------|
| sandbox | ✅ | ⚠️ 需读 instance/credential | ✅ | 中 | 优先拆 |
| users | ✅ | ✅ | ✅ | 低 | 优先拆 |
| permission | ✅ | ✅ | ✅ | 低 | 优先拆，但保留共享 |
| topology | ✅ | ✅ | ✅ | 低 | 可拆 |
| template | ⚠️ 依赖 sandbox type | ⚠️ | ❌ | 高 | 暂不拆 |
| volume | ✅ | ✅ | ✅ | 低 | 可拆为 sandbox 子域 |
| container-secret | ✅ | ✅ | ✅ | 低 | 可拆为 sandbox 子域 |
| network/subnet | ✅ | ✅ | ✅ | 低 | 可拆为 topology 子域 |
| system-group | ✅ | ✅ | ✅ | 低 | 可归入 permission |
| dns | ✅ | ✅ | ✅ | 低 | 可拆为 topology 子域 |
| audit | ✅ | ✅ | ✅ | 低 | 独立部署 |

## 六、拆分路径（如果要做）

### Phase 1: 类型解耦（0 风险，纯重构）

```
src/core/deps.ts    ← 新增，从 app.ts 移出 FeatureDeps/AppContext/AppInstance
src/core/app.ts     ← import from deps.ts
features/*/handler  ← import from deps.ts (不再 import app.ts)
```

**效果**: 消灭 25 个循环依赖。feature handler 不再依赖 app.ts。

### Phase 2: 数据边界显式化

每个 feature 的 store key 前缀在 `FeatureDeps` 里声明：

```typescript
interface FeatureDeps {
  stores: Stores;
  keyPrefix: string;  // 每个 feature 追加到此前缀
  // ...
}
```

沙箱服务只读写 `sandbox:*`，用户服务只读写 `user:*`。手工执行——没有框架强制。

### Phase 3: 第一个独立服务（sandbox）

```
hbi-aad-sandbox/
  wrangler.toml        ← 自己的 Worker
  src/index.ts         ← 自己的 createApp()（只含 sandbox feature）
  src/store/           ← 独立的 KV/DO namespace
```

- 有自己的 `ATOMIC_STORE_DO`（不同 DO namespace，物理隔离）
- 读 instance/credential 通过 HTTP 调用 topology 服务
- health:check 只扫自己的 `sandbox:ids`

### Phase 4: API Gateway

```
客户端 → api.yourdomain.com → Cloudflare API Gateway
         ├── /api/sandboxes/*  → sandbox Worker
         ├── /api/users/*      → users Worker
         ├── /api/topology/*   → topology Worker
         └── /api/permissions/* → permission Worker
```

Cloudflare 不支持原生 API Gateway，但可以用：
- **Worker Router**: 一个入口 Worker 按路径前缀 proxy 到不同 Worker
- **Cloudflare SaaS**: 不同子域名挂不同 Worker
- **Hono RPC**: 跨 Worker 的 type-safe 调用

## 七、建议优先级

| 优先级 | 动作 | 收益 | 风险 |
|--------|------|------|------|
| 🔴 高 | Phase 1 — FeatureDeps 类型解耦 | 消灭 25 个循环依赖 | 零 |
| 🟡 中 | Phase 2 — key prefix 显式声明 | 数据边界清晰 | 零 |
| 🟢 低 | Phase 3 — sandbox 独立服务 | 独立部署/扩缩 | 中（跨服务查询） |
| ⏳ 暂缓 | Phase 4 — API Gateway | 完整微服务 | 高 |

## 八、当前架构的优点（不拆的理由）

1. **简单**: 一个 `npm run dev:worker` 启动全部功能。12 个服务需要 12 个终端窗口。
2. **类型安全**: `FeatureDeps` 传递全量依赖，TypeScript 校验贯穿全部层级。
3. **事务性**: `stores.atomic.transact()` 可以原子更新 sandbox + user + audit，跨服务做不到。
4. **调试成本**: 一个 Worker 的日志 vs 12 个 Worker 的分布式追踪。
5. **20k 行**: 这个规模下，单体比微服务更适合。

**客观结论**: 当前耦合度由共享 `IAtomicStore` 和集中式 DI 造成，但这是 Cloudflare Workers 单仓库的**合理架构选择**。真正卡拆分的不是代码质量，是**分布式数据一致性**的成本与微服务收益的不对等。
