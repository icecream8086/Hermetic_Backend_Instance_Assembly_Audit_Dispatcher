# HBI-AAD 通用后端架构设计方案 v4.0

## 1. 设计理念与全局约束

本架构遵循以下不可妥协的原则：

- **有向无环依赖**：所有模块间依赖关系必须是单向无环，通过接口依赖倒置，消除循环。
- **编译期安全优先**：充分利用 TypeScript 结构化类型与品牌类型，阻止常见误用模式（`as`、属性错位、绕过序列化），将错误消灭在编译阶段。
- **最小权限暴露**：接口按读写、管理职能拆分，任何组件仅获得完成自身职责所需的最小类型集合。
- **显式优于隐式**：所有配置、路由、跨层交互均在类型系统中有静态体现，禁止静默降级与魔法兜底。
- **生命周期受控**：所有有状态资源（连接、缓冲、锁）具备明确的创建、使用、释放路径，杜绝隐式全局单例。

---

## 2. 顶层项目结构（垂直切片+水平分层）

```
src/
├── features/                  # 业务功能垂直切片
│   └── {feature}/
│       ├── {feature}.handler.ts
│       ├── {feature}.service.ts
│       ├── {feature}.schema.ts
│       └── {feature}.router.ts
├── core/                      # 跨切面共享层
│   ├── logger/                # 审计级日志子系统
│   │   ├── interfaces.ts
│   │   ├── formatter.ts
│   │   ├── router.ts
│   │   ├── tail-coordinator/
│   │   └── storage-adapters/
│   ├── store/                 # 通用存储抽象（状态、查询、Blob）
│   │   ├── interfaces.ts
│   │   ├── adapters/
│   │   └── config.ts
│   ├── middleware/
│   ├── utils/
│   └── app.ts
├── config/
│   └── env.ts
├── cron/
└── index.ts
```

**依赖规则**：`features` 只能依赖 `core`，`core` 内部子模块按 DAG 组织，`features` 之间禁止直接引用。

---

## 3. 通用存储抽象（DB 层）

为隔离云厂商与产品，定义三层接口：热状态、冷查询、二进制归档。实现通过依赖注入按环境切换。

### 3.1 热状态层（原子操作与状态机）

```typescript
interface IAtomicStore {
  /** 读取实体当前值及版本号（乐观锁） */
  get<T>(key: string): Promise<{ value: T; version: VersionId } | null>;

  /** 带版本检查的原子写入，返回新版本；冲突时返回 null */
  set<T>(key: string, value: T, expectedVersion: VersionId | null): Promise<VersionId | null>;

  /** 启动事务，内部操作串行且原子 */
  transact<T>(action: (txn: IStoreTransaction) => Promise<T>): Promise<T>;
}

interface IStoreTransaction {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): void;
}
```

- **VersionId**：品牌类型 `type VersionId = string & { [VERSION_ID_BRAND]: true }`，内部由 `generateVersionId()` 唯一创建。
- 实现：Cloudflare Durable Object、Restate、自定义 Redis/PostgreSQL 事务包装。

### 3.2 冷查询层（关系查询、复杂报表）

```typescript
interface IQueryStore {
  execute<T = unknown>(sql: string, params?: QueryParams): Promise<T[]>;
  // 可选：特定实体的类型安全方法
}
```

- 实现：D1、Turso、PostgreSQL 等。所有结果以泛型数组返回，业务层自行转换。

### 3.3 二进制归档层（大对象、日志备份）

```typescript
interface IBlobStore {
  put(key: string, body: ReadableStream | Buffer, metadata?: BlobMetadata): Promise<void>;
  get(key: string): Promise<ReadableStream | null>;
  delete(key: string): Promise<void>;
}
```

- 实现：Cloudflare R2、AWS S3、MinIO。

### 3.4 依赖注入与配置切换

```typescript
interface StorageConfig {
  stateBackend: 'do' | 'restate' | 'pg';
  queryBackend: 'd1' | 'turso' | 'pg';
  blobBackend: 'r2' | 's3';
  // 各后端所需凭证、绑定信息...
}

function createStores(config: StorageConfig) {
  return {
    atomic: createAtomicStore(config.stateBackend, config),
    query: createQueryStore(config.queryBackend, config),
    blob: createBlobStore(config.blobBackend, config),
  };
}
```

所有业务逻辑通过 `IAtomicStore`、`IQueryStore`、`IBlobStore` 接口操作，不感知具体实现。

---

## 4. 品牌类型与输入抽象（防呆核心）

为杜绝属性错位、绕过构造、`as` 滥用，所有系统内部标识符（ID、标识、序列化标记）均采用不可伪造的品牌类型。

### 4.1 品牌类型实现策略

```typescript
declare const ID_BRAND: unique symbol;
type LogId = string & { [ID_BRAND]: true };

function createLogId(raw: string): LogId {
  if (!/^\d{16}-[a-f0-9]{12}$/.test(raw)) throw new TypeError('Invalid LogId');
  return raw as LogId; // 唯一可控构造点
}
```

- 凡需要 `LogId` 之处，均不接受裸 `string`。
- 尝试 `"abc" as LogId` 将编译失败，因为缺少 `[ID_BRAND]` 属性。

### 4.2 输入与内部类型分离

不对外暴露 `Omit<Entity, 'id'|...>`，而单独定义 `Input` 类型：

```typescript
interface CreateOrderInput {
  facility: Facility;
  amount: number;
}
// Order 为完整实体，仅内部可见
interface Order extends CreateOrderInput {
  id: OrderId;
  createdAt: number;
}
```

调用方只触碰 `Input`，无法误传内部字段。

### 4.3 序列化安全（防格式分叉）

```typescript
declare const SERIAL_BRAND: unique symbol;
type SerializedBody = string & { [SERIAL_BRAND]: true };

interface ILogFormatter {
  serialize(entry: LogEntry): SerializedBody;
  deserialize(body: SerializedBody): LogEntry;
}
```

存储层使用 `SerializedBody`，无法自行 `JSON.stringify` 绕过 Formatter。

---

## 5. 审计级日志子系统

### 5.1 审计能力等级（强契约）

```typescript
enum AuditTier {
  AUDITABLE = "auditable",   // 链表完整，落盘可靠
  BEST_EFFORT = "best-effort"
}
```

任何 `ILogger` 实例公开其 `auditTier`，调用方可据此判断是否可记录敏感操作。

### 5.2 核心接口（读写权限分离）

```typescript
// 业务层写入接口
interface ILogWriter {
  /** 审计模式：写入并等待单条落盘 + 链尾推进完成。成功返回日志id */
  logSync(input: LogInput): Promise<LogId>;

  /** 非审计模式：入队缓冲，不保证落盘 */
  logAsync(input: LogInput): Promise<void>;
}

// 业务层读取接口
interface ILogReader {
  query(params: LogQuery): Promise<PaginatedResult<LogEntry>>;
}

// 管理接口（仅恢复/归档脚本持有）
interface ILogAdmin {
  forceSetTail(facility: Facility, tailId: LogId): Promise<void>;
  prune(beforeTs: number): Promise<number>;
}

// 完整 Logger 聚合
interface ILogger extends ILogWriter, ILogReader {
  readonly auditTier: AuditTier;
  flush(): Promise<void>;
  dispose(): Promise<void>;
}
```

- `ILogRouter.resolve(facility)` 仅返回 `ILogWriter & ILogReader`，不暴露管理操作。
- `ILogAdmin` 单独注入至冷启动脚本或运维工具。

### 5.3 存储层接口（仅接触序列化格式）

```typescript
interface ILogStorageWriter {
  append(entry: StorageEntry): Promise<void>;
  appendBatch(entries: StorageEntry[]): Promise<void>;
}
interface ILogStorageReader {
  queryRange(facility: Facility, startTs: number, endTs: number, cursor?: string): Promise<{ items: SerializedLogEntry[]; nextCursor?: string }>;
  getById(facility: Facility, id: LogId): Promise<SerializedLogEntry | null>;
}
interface ILogStorageAdmin {
  prune(beforeTs: number): Promise<number>;
}
```

- `StorageEntry` 包含 `facility: Facility, id: LogId, body: SerializedBody`。
- 反序列化统一由 `ILogFormatter` 处理，存储层不触碰 `LogEntry`。

### 5.4 审计链路保证（两阶段提交 + 恢复）

- **写入流程**：先落盘日志（`append`），再原子推进链尾（`ILogTailCoordinator.tryAdvance`），失败则重试。最终失败标记孤立日志并写告警，但日志不可丢。
- **链尾协同**：`ILogTailCoordinator` 在 Cloudflare 中由 DO 事务实现，PostgreSQL 用 `UPDATE ... WHERE tail_id = expected`，Redis 用 Lua。
- **崩溃恢复**：冷启动时遍历链尾，用 `prevId` 反向校验完整性，遇断裂用 `forceSetTail` 修复并记录恢复日志。

### 5.5 边界条件与分页

- `ILogReader.query` 支持分页：参数 `limit`（默认 100，最大 1000）与 `cursor`（基于时间戳+ID 的游标）。
- 返回 `PaginatedResult<LogEntry>` 包含 `items` 与 `nextCursor`。
- 全系统所有列表查询均采用基于游标的分页，避免传统 OFFSET 在大数据量下的性能与一致性问题。

---

## 6. Web 框架与类型安全路由

采用 Hono 作为 HTTP 层，利用 RPC 模式实现端到端类型安全。

### 6.1 路由组织

每个 Feature 内定义 `*.router.ts`，导出 `Hono` 实例，在 `app.ts` 中挂载：

```typescript
const app = new Hono()
  .route('/api/orders', orderRouter)
  .route('/api/users', userRouter);
```

### 6.2 输入校验与类型推导

- 采用 Zod schema 定义请求体、路径、查询参数。
- 使用 `zValidator` 中间件，验证通过后 `c.req.valid()` 直接返回推导后的强类型。
- 不使用泛型注解，所有类型由 Zod + Hono 自动推导。

### 6.3 客户端类型生成

- 导出 `export type AppType = typeof app`。
- 客户端通过 `hc<AppType>(url)` 获得完全类型安全的调用，杜绝路径、参数拼写错误。

---

## 7. 边界条件通用处理策略

### 7.1 分页

- 全系统统一使用 **基于游标（cursor）** 的分页。
- 请求参数：`limit?: number`，`cursor?: string`。
- 响应格式：

  ```typescript
  interface PaginatedResult<T> {
    items: T[];
    nextCursor?: string;   // 无下一页时为 undefined
    total?: number;        // 可选的大致总数，非精确实时
  }
  ```

- Storage 层实现对应的范围扫描逻辑，利用键/时间戳排序。

### 7.2 限流与防护

- 所有对外路由入口可接入速率限制中间件，基于令牌桶/滑动窗口，由配置驱动阈值。
- Worker 环境下利用 Cloudflare Rate Limiting 或自行基于 KV 实现。

### 7.3 错误处理

- 全局错误处理中间件捕获所有未处理异常，统一返回 `{ error: string, code: number }`。
- 自定义错误类携带 HTTP 状态码和错误码，方便国际化。
- 内部实现禁止吞没错误，所有 catch 需显式重新抛出或记录审计日志。

### 7.4 幂等性

- 对状态变更操作，客户端可提供 `Idempotency-Key` 头，由业务层通过 `IAtomicStore` 检查并保证幂等。

---

## 8. 依赖注入与生命周期管理

### 8.1 核心容器

不使用重型 IoC 框架，采用 **工厂函数 + 配置对象** 的手动注入模式：

- `createApp(config: AppConfig)` 返回 `{ app, stores, logger }`。
- 每个请求通过 Hono 中间件将 `stores` 和 `logger` 注入上下文。
- 请求级 `ILogger` 实例为独立缓冲，随请求结束通过 `ctx.waitUntil` 刷盘并释放。

### 8.2 资源释放

- 所有实现 `IDisposable` 的资源（如长连接、缓存）在应用关闭（或 Worker 终止）时调用 `dispose()`。
- `createApp` 返回 `dispose()` 函数供环境集成。

---

## 9. 配置与可切换性

### 9.1 配置结构

```typescript
interface AppConfig {
  storage: StorageConfig;
  log: LogConfig;          // 审计级别、后端选择、归档配置等
  server: { port?: number };
  features: FeatureFlags;
}
```

- 所有后端切换通过修改 `AppConfig` 实现，不修改业务代码。
- 严格校验启动配置，非法配置抛错阻止启动。

---

## 10. 架构质量属性总结

| 质量属性     | 实现方式 |
|-------------|---------|
| **可测试性** | 所有接口均可 mock，纯函数核心逻辑，无全局状态 |
| **安全性**   | 品牌类型防误用，权限分离，输入校验，溢出控制 |
| **可维护性** | 垂直切片，显式依赖，类型自动推导，无魔法反射 |
| **可扩展性** | 接口抽象，插件式存储适配，功能开关 |
| **可审计性** | 日志不可抵赖链，读写分离，序列化版本化 |
| **环境中立** | 所有外部依赖通过接口隔离，配置文件切换厂商 |

本架构基于 TypeScript 语言特性、边缘计算环境约束以及工程实践经验打磨而成，可支撑从个人项目到中型 SaaS 的全周期开发，在严格性与灵活性间取得最佳平衡。
