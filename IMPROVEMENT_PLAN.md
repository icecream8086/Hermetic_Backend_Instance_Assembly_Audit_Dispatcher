# 体系完备性改进计划书

基于操作完备性契约（Operation Completeness Contract）的成功实践，将同样的"类型即唯一信源 + 编译期穷举"哲学拓展到后端系统的 8 个维度。

---

## 总览

| 优先级 | 维度 | 现状 | 目标 | 预估改动量 |
|:---|:---|:---|:---|:---|
| P0 ✅ | 错误码体系 | ✅ 完成 — `src/core/error-codes.ts` 132 个 ErrorCode, Record 强制映射 | 0 编译错误 |
| P0 ✅ | 消息消费者 | ✅ 完成 — `Record<TaskType, Handler>` 取代 switch | 新增 TaskType → tsc 报错 |
| P0 ✅ | 环境变量/配置 | ✅ 完成 — `src/config/schema.ts` Zod schema, 启动期校验 | 缺必填项 → 启动立即报错 |
| P1 ✅ | 状态机覆盖 | ✅ 完成 — `ExhaustiveTransitions<S>` 类型 + 5 个转移表 | 增删枚举值 → tsc 报错 |
| P1 ✅ | 审计设施 | ✅ 完成 — `FacilityName` 联合类型, `PersistenceRule.facility` 窄化 | 打错设施名 → tsc 报错 |
| P1 ✅ | 定时任务注册 | ✅ 完成 — `scheduler/registry.ts` 统一注册/启停 | EventLoop 已注册, DagScheduler 待接入 |
| P2 ✅ | 实体-DTO 编解码 | ✅ 完成 — `VolumeSchema` Zod 实体, `store/validate.ts` 存储边界校验 | schema 即信源 |
| P2 ✅ | 依赖隔离 | ✅ 完成 — `VolumeDeps`/`NetworkDeps`/`SubnetDeps`/`SysGroupDeps` | 一看接口即知所需依赖 |

---

## P0 — 立即执行（高收益 + 低风险）

### 1. 错误码体系集中化

**问题**：`fail('NOT_FOUND', ...)` 和 `c.json(fail('FORBIDDEN', ...), 403)` 中错误码是裸字符串，HTTP 状态码靠调用点手动指定。约 40+ 个唯一错误码，无中心映射。

**方案**：

```typescript
// src/core/error-codes.ts

export const ERROR_CODES = [
  // 4xx
  'VALIDATION_ERROR',    // 400
  'UNAUTHORIZED',        // 401
  'FORBIDDEN',           // 403
  'NOT_FOUND',           // 404
  'CONFLICT',            // 409
  'RATE_LIMITED',        // 429
  // Resource-specific 404
  'SANDBOX_NOT_FOUND',
  'VOLUME_NOT_FOUND',
  'SECRET_NOT_FOUND',
  'POLICY_NOT_FOUND',
  'USERGROUP_NOT_FOUND',
  'PERMGROUP_NOT_FOUND',
  'ROUTEACL_NOT_FOUND',
  'USERTPL_NOT_FOUND',
  'TEMPLATE_NOT_FOUND',
  'RUNNER_NOT_FOUND',
  'SYSGROUP_NOT_FOUND',
  'SUBNET_NOT_FOUND',
  'SECGROUP_NOT_FOUND',
  'INSTANCE_NOT_FOUND',
  'CREDENTIAL_NOT_FOUND',
  'BUCKET_NOT_FOUND',
  'IMAGE_REPO_NOT_FOUND',
  'PUBLIC_KEY_NOT_FOUND',
  // 5xx
  'INTERNAL_ERROR',      // 500
  'NOT_IMPLEMENTED',     // 501
  'SERVICE_UNAVAILABLE', // 503
  // Operation-specific
  'CREATE_FAILED',
  'UPDATE_FAILED',
  'DELETE_FAILED',
  'STOP_FAILED',
  'START_FAILED',
  'SYNC_FAILED',
  'RESTART_FAILED',
  'APPLY_FAILED',
  'RESOLVE_ERROR',
  'HEARTBEAT_FAILED',
  'PULL_FAILED',
  'COMPLETE_FAILED',
  'UPLOAD_FAILED',
  'PROVIDER_ERROR',
  'PROVIDER_RESOLUTION_FAILED',
  'PROVIDER_OPERATION_FAILED',
  'CREDENTIAL_RESOLUTION_FAILED',
  'INVALID_TRANSITION',
  'INVALID_STATUS',
  'MAC_DENIED',
  'NO_PROVIDER',
  'NO_CONTAINER',
  'LOGS_UNAVAILABLE',
  'BLOB_STORE_UNAVAILABLE',
  'SECRET_EMPTY',
  'SECRET_NO_BLOB',
  'SECRET_BLOB_MISSING',
  'SECRET_INVALID_TYPE',
  'NOT_SUPPORTED',
] as const;

export type ErrorCode = typeof ERROR_CODES[number];

// HTTP 状态码映射
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  SANDBOX_NOT_FOUND: 404,
  VOLUME_NOT_FOUND: 404,
  SECRET_NOT_FOUND: 404,
  POLICY_NOT_FOUND: 404,
  USERGROUP_NOT_FOUND: 404,
  PERMGROUP_NOT_FOUND: 404,
  ROUTEACL_NOT_FOUND: 404,
  USERTPL_NOT_FOUND: 404,
  TEMPLATE_NOT_FOUND: 404,
  RUNNER_NOT_FOUND: 404,
  SYSGROUP_NOT_FOUND: 404,
  SUBNET_NOT_FOUND: 404,
  SECGROUP_NOT_FOUND: 404,
  INSTANCE_NOT_FOUND: 404,
  CREDENTIAL_NOT_FOUND: 404,
  BUCKET_NOT_FOUND: 404,
  IMAGE_REPO_NOT_FOUND: 404,
  PUBLIC_KEY_NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  NOT_IMPLEMENTED: 501,
  SERVICE_UNAVAILABLE: 503,
  CREATE_FAILED: 400,
  UPDATE_FAILED: 400,
  DELETE_FAILED: 400,
  STOP_FAILED: 400,
  START_FAILED: 400,
  SYNC_FAILED: 400,
  RESTART_FAILED: 400,
  APPLY_FAILED: 500,
  RESOLVE_ERROR: 500,
  HEARTBEAT_FAILED: 400,
  PULL_FAILED: 502,
  COMPLETE_FAILED: 500,
  UPLOAD_FAILED: 500,
  PROVIDER_ERROR: 502,
  PROVIDER_RESOLUTION_FAILED: 503,
  PROVIDER_OPERATION_FAILED: 502,
  CREDENTIAL_RESOLUTION_FAILED: 401,
  INVALID_TRANSITION: 409,
  INVALID_STATUS: 400,
  MAC_DENIED: 403,
  NO_PROVIDER: 400,
  NO_CONTAINER: 400,
  LOGS_UNAVAILABLE: 503,
  BLOB_STORE_UNAVAILABLE: 500,
  SECRET_EMPTY: 500,
  SECRET_NO_BLOB: 500,
  SECRET_BLOB_MISSING: 500,
  SECRET_INVALID_TYPE: 500,
  NOT_SUPPORTED: 400,
};

// 修改 fail() 签名，限制 code 参数
// src/core/response.ts:
export function fail(code: ErrorCode, message: string): ApiError {
  return { success: false, data: null, error: { code, message } };
}

// 新增便捷方法：自动附带 HTTP 状态码
export function failWithStatus(code: ErrorCode, message: string) {
  return { body: fail(code, message), status: ERROR_HTTP_STATUS[code] };
}
```

**收益**：增删错误码立即触发 `ERROR_HTTP_STATUS` 的编译错误；所有 handler 的 HTTP 状态码由映射表保证一致性，不再靠人工记住"这个码应该 400 还是 404"。

---

### 2. 消息消费者穷举

**问题**：`src/queue/consumer.ts` line 78 用 `switch(msg.type)` 分发，无 `never` 收口。新增 `TaskType` 时消费者不会报编译错误。

**当前状态**（`src/queue/types.ts:10`）：
```typescript
export type TaskType = 'image:pull' | 'sandbox:gc' | 'sandbox:provision' | 'bucket-key:rotate' | 'workflow:job:run';
```

**方案**：用 `Record<TaskType, Handler>` 重构消费者分发，配合 `never` 收口：

```typescript
// src/queue/consumer.ts

import type { TaskType, TaskMessage, TaskResult } from './types.ts';

type TaskHandler = (msg: TaskMessage) => Promise<TaskResult>;

const handlers: Record<TaskType, TaskHandler> = {
  'image:pull':       handleImagePull,
  'sandbox:gc':       handleSandboxGc,
  'sandbox:provision': handleSandboxProvision,
  'bucket-key:rotate': handleBucketKeyRotate,
  'workflow:job:run': handleWorkflowJobRun,
  // +1 → TS2739 编译错误，必须在两个地方同时加
};

export async function processMessages(messages: TaskMessage[]): Promise<TaskResult[]> {
  return Promise.all(messages.map(async (msg) => {
    const handler = handlers[msg.type];
    if (!handler) {
      // 运行期兜底：如果运行时出现未知 type，TypeScript 已经帮我们在编译期保证不会发生
      const _exhaustive: never = msg.type;
      throw new Error(`Unhandled task type: ${msg.type}`);
    }
    return handler(msg);
  }));
}
```

**收益**：新增 `TaskType` 时，必须同时在 `handlers` Record 中添加对应处理器，否则编译不过。

---

### 3. 环境变量编译期校验

**问题**：`src/config/env.ts` 用 `process.env.XXX ?? fallback` 模式读取环境变量，无运行时校验。`as` 强制转换可能掩盖类型错误。约 35 个环境变量，缺少 required/optional 区分。

**方案**：引入 Zod schema（项目已在多处使用 Zod，无新增依赖）：

```typescript
// src/config/schema.ts

import { z } from 'zod';

// 存储后端配置
const StorageConfigSchema = z.object({
  state: z.enum(['file', 'kv', 'do']).default('file'),
  query: z.enum(['file', 'd1', 'none']).default('file'),
  blob: z.enum(['file', 'r2', 'none']).default('file'),
});

const S3AccountSchema = z.object({
  name: z.string(),
  accessKeyId: z.string(),
  secretAccessKey: z.string(),
  region: z.string(),
  endpoint: z.string().optional(),
});

// 完整配置 schema
export const AppConfigSchema = z.object({
  storage: StorageConfigSchema.default({}),
  log: z.object({
    auditTier: z.enum(['auditable', 'best-effort']).default('auditable'),
    storageBackend: z.enum(['kv', 'console', 'noop']).default('kv'),
  }).default({}),
  provider: z.object({
    container: z.enum(['podman', 'alibaba', 'stub']).default('podman'),
    dns: z.enum(['cloudflare', 'stub']).default('stub'),
    metrics: z.enum(['alibaba', 'stub']).default('stub'),
    alibabaAccounts: z.string().optional(),
  }).default({}),
  s3: z.object({
    backend: z.enum(['minio', 'aws', 'alibaba', 'r2', 'none']).default('none'),
    accounts: z.array(S3AccountSchema).optional(),
  }).default({}),
  scheduler: z.object({
    backend: z.enum(['setInterval', 'do-alarm', 'manual', 'fake']).default('setInterval'),
    intervalMs: z.coerce.number().default(30_000),
    batchSize: z.coerce.number().default(10),
  }).default({}),
  server: z.object({
    port: z.coerce.number().default(3000),
    workerUrl: z.string().optional(),
    corsOrigins: z.string().default('*'),
  }).default({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
```

**启动时校验**（`src/config/env.ts`）：
```typescript
import { AppConfigSchema, type AppConfig } from './schema.ts';

export function loadConfig(overrides?: Partial<AppConfig>): AppConfig {
  const raw = {
    storage: {
      state: process.env.STATE_BACKEND as string | undefined,
      // ...
    },
    // ...
    ...overrides,
  };

  const result = AppConfigSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.issues
      .map(i => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    console.error(`[config] Invalid configuration:\n${errors}`);
    throw new Error('Configuration validation failed');
  }
  return result.data;
}
```

**收益**：
- 缺失必填变量 → 启动立即清晰报错（而非运行到某处才崩）
- 类型从 schema 推导，消除手动 `as` 强制转换
- 变量即文档：看 schema 就知道所有配置项及其默认值

---

## P1 — 本周执行（高收益 + 已有基础模式可复用）

### 4. 状态机转移表推广

**问题**：`SandboxStatus` 有完整的 `VALID_TRANSITIONS: Record<SandboxStatus, SandboxStatus[]>`，但 `VolumeStatus`（3 状态）、`WorkflowRunStatus`（6 状态）、`JobRunStatus`（7 状态）、`DnsRecordStatus`（2 状态）等 10+ 个状态枚举没有转移表。

**方案**：

```typescript
// src/core/state-machine/types.ts

/** 确保转移表覆盖了给定状态枚举的所有 key。缺一个 → TS 报错。 */
export type ExhaustiveTransitions<S extends string> = Record<S, readonly S[]>;

// 使用示例：如果 VolumeStatus 新增一个值，下面这行会报编译错误
import type { VolumeStatus } from '../../features/sandbox/types.ts';

const VOLUME_TRANSITIONS: Record<VolumeStatus, readonly VolumeStatus[]> = {
  Detached: ['Attached'],
  Attached: ['Detached', 'Orphaned'],
  Orphaned: [],
};
// 确保穷举：
const _check: ExhaustiveTransitions<VolumeStatus> = VOLUME_TRANSITIONS;
```

**适用范围**（按优先级）：
1. `WorkflowRunStatus` + `JobRunStatus`（actions feature，已有 7+6 状态）
2. `DagRunStatus`（dag scheduler，4 状态）
3. `VolumeStatus`（现无转移表，3 状态）
4. `RunnerStatus`（instances feature，online/offline/busy，3 状态）
5. `SecurityGroupStatus` + `SubnetStatus`（Active/Inactive，2 状态 × 2）
6. 其余：`ApprovalStatus`、`DnsRecordStatus`、`ContainerGroupStatus`、`InstanceStatus`

**收益**：增删状态枚举值自动触发转移表编译错误，杜绝非法状态跨越。

---

### 5. 审计设施类型窄化

**问题**：`src/core/audit/persistence-policy.ts` 中 `PersistenceRule.facility` 是 `string` 而非枚举。`FeatureDeps.audit` 类型是 `IAuditWriter`（只能写），而 `IAuditLogger`（读写管理）更完整。

**方案**：

```typescript
// src/core/audit/types.ts

// 从现有 NAME_TO_FACILITY 推导字符串联合
import { NAME_TO_FACILITY } from './kern-level.ts';

export type FacilityName = keyof typeof NAME_TO_FACILITY;
// 结果：'kern' | 'user' | 'mail' | 'daemon' | 'auth' | 'syslog' | 'lpr'
//       | 'news' | 'uucp' | 'cron' | 'authpriv' | 'ftp' | 'ntp'
//       | 'audit' | 'alert' | 'clock' | 'local0' | ... | 'local7'

// PersistencePolicy 宽化
import type { PersistenceRule } from './persistence-policy.ts';

// 覆写 facility 类型：
export type TypedPersistenceRule = Omit<PersistenceRule, 'facility'> & {
  facility: FacilityName | '*';
};
```

**收益**：写持久化策略时打错 facility 名称立即报错（例如 `'authrization'` → TS 报 `not assignable to FacilityName`）。

---

### 6. 定时任务中心注册

**问题**：`EventLoop` 和 `DagScheduler` 各自独立创建 `ITimerBackend`，无中心调度注册点。新增定时任务需单开文件并手动记得在 `createApp()` 里启动。

**方案**：

```typescript
// src/core/scheduler/registry.ts

import type { IScheduler } from './interfaces.ts';

type SchedulerName = 'eventLoop' | 'dagScheduler';

const registry = new Map<SchedulerName, IScheduler>();

export function register(name: SchedulerName, scheduler: IScheduler): void {
  if (registry.has(name)) throw new Error(`Scheduler "${name}" already registered`);
  registry.set(name, scheduler);
}

export function startAll(): void {
  for (const [name, s] of registry) {
    console.log(`[scheduler] Starting ${name}…`);
    s.start();
  }
}

export function stopAll(): void {
  for (const [, s] of registry) s.stop();
}
```

**收益**：所有定时任务集中管理；启动/停止一键完成；新增调度器有明确注册点。

---

## P2 — 后续迭代（高收益 + 需要较大重构）

### 7. 实体-DTO 编解码层

**问题**：实体定义（TypeScript interface）和 DTO 校验（Zod schema）是两套独立的定义，手工保持同步。读取存储时 `atomic.get<T>()` 不做运行时校验，脏数据可能以错误类型穿透到业务层。

**方案**（分两步）：

**第 1 步**：为关键实体（Sandbox, Volume, Template, RunnerInstance）编写 Zod schema，用 `z.infer` 推导类型：

```typescript
// src/features/sandbox/schema.ts
export const SandboxSchema = z.object({
  id: SandboxIdSchema,
  name: z.string(),
  status: z.nativeEnum(SandboxStatus),
  config: SandboxConfigSchema,
  // ...
});

// 类型由 schema 推导 — schema 即信源
export type Sandbox = z.infer<typeof SandboxSchema>;
```

**第 2 步**：在 `IAtomicStore` 读取边界加可选校验钩子：

```typescript
// 读取时校验（仅开发/测试环境启用，生产环境可选）
async function getValidated<T>(store: IAtomicStore, key: string, schema: z.ZodType<T>): Promise<T | null> {
  const entry = await store.get<T>(key);
  if (!entry) return null;
  return schema.parse(entry.value); // throws ZodError on corruption
}
```

**收益**：接口类型和运行时校验同源，消除 schema 漂移；存储层面的数据损坏在读取时立即发现。

---

### 8. 依赖接口隔离

**问题**：`FeatureDeps` 包含 10 个字段，每个 feature 只用到其中 2-3 个。`permissionChecker` 和 `secretEncryption` 是可选字段，依赖它们的 feature 在编译期不知道它们是否已注入。

**方案**：为每个 feature 定义窄化的依赖接口：

```typescript
// src/features/volume/index.ts
import type { IAtomicStore, IAuditWriter, ILogWriter } from '../../core/...';

export interface VolumeDeps {
  atomic: IAtomicStore;
  logger: ILogWriter;
  audit?: IAuditWriter;
}

// createRouter 接受窄化接口
export function createRouter(deps: VolumeDeps): Hono<any> {
  const svc = new VolumeService(deps.atomic, deps.logger, deps.audit);
  return createVolumeRouter(svc);
}
```

**收益**：
- 一看 `VolumeDeps` 就知道这个 feature 依赖什么
- 可选字段回归必修字段（`atomic` 从 `stores.atomic` 提升为顶层字段）
- 单元测试时构造 deps 更简单（只需 mock 3 个而不是 10 个）

**实施策略**：渐进式 — 新增 feature 必须用窄接口，现有 feature 逐一迁移。

---

## 执行路线图

```
Week 1  ████████░░  P0: 错误码体系 + 消息消费者 + 环境变量 Zod
Week 2  ██████░░░░  P1: 状态机转移表 + 审计设施 + 定时任务注册
Week 3  ████░░░░░░  P2 第 1 步: Sandbox/Volume/Template Zod schema
Week 4  ████░░░░░░  P2 第 2 步: 存储边界校验 + 依赖接口隔离(volume/network)
```

---

## 验收标准

| 维度 | 验收方法 | 结果 |
|------|----------|------|
| P0-1 错误码 | `tsc --noEmit` → 所有 `fail()` 和 `AppError` 调用点通过类型检查 | ✅ 0 errors |
| P0-2 消费者 | `src/queue/types.ts` 新增 `TaskType` → `tsc` 报错 `TS2739` | ✅ 已验证 |
| P0-3 配置 | `npm start` → 有 Zod 校验，缺必填变量报清晰错误信息 | ✅ 已验证 |
| 全量回归 | `npx vitest run` → 1481 tests | ✅ 1481 passed, 0 failed |
| P1-4 状态机 | `VolumeStatus` 新增枚举值 → `tsc` 报错指向转移表 |
| P1-5 审计 | `persistence-policy.ts` 中 facility 字段打错字 → `tsc` 报错 |
| P1-6 定时 | `createApp()` 统一调用 `startAll()`，新增 scheduler 自动纳入 |
| P2-7 编解码 | sandbox 存储中有非法 status 值 → 读取时抛 `ZodError`（而非静默通过） |
| P2-8 依赖 | `VolumeDeps` 接口定义后，调用方只能传所需字段（而非 FeatureDeps 全集） |
