# D1 + Drizzle ORM 迁移计划

## 背景

当前项目使用 3 层存储：

| 层 | 后端 | 用途 |
|---|---|---|
| IAtomicStore | DO / KV / file | OCC 状态，实体读写 |
| IQueryStore | D1 / file / none | 关系查询，翻页，过滤 |
| IBlobStore | R2 / file / none | 二进制大对象 |

`IQueryStore` 目前几乎未被业务代码使用——所有查询走 AtomicStore 的全量扫描 + 内存过滤，每次请求都 O(n) 遍历所有 route ACL / perm group / user group。

## Drizzle ORM 方案

### 为什么选 Drizzle

Drizzle ORM 是唯一原生支持 Cloudflare D1 的主流 ORM：

```ts
import { drizzle } from 'drizzle-orm/d1';

// workerd 运行时直接可用，零胶水
const db = drizzle(env.DB);
const result = await db.select().from(policies).where(eq(policies.effect, 'allow'));
```

| 对比 | Drizzle ORM | MikroORM |
|---|---|---|
| workerd 兼容 | ✅ 原生 `drizzle-orm/d1` | ❌ 需要 N-API addon |
| D1 driver | ✅ 内置 | ❌ 需要自写 |
| Bundle size | 小（tree-shakeable） | 大（full-featured ORM） |
| 类型安全 | ✅ | ✅ |
| 迁移工具 | `drizzle-kit` | `mikro-orm migration:*` |
| SQL 风格 | SQL-like（贴近原生） | OOP（identity map + 级联） |

### 架构

```
┌────────────────────────────────────────────────────────────┐
│                                                            │
│ 业务层 (Feature Services)                                  │
│ ┌────────────────────────────────────────────────────┐     │
│ │ PermissionChecker.check()                          │     │
│ │ SandboxService.list(status)                        │     │
│ │ RouteAclManager.checkAccess()                      │     │
│ └────────────────┬───────────────────────────────────┘     │
│                  │                                         │
│          ┌───────┴───────┐                                 │
│          ▼               ▼                                 │
│   ┌────────────┐  ┌──────────────┐                        │
│   │ AtomicStore │  │ Drizzle ORM │                        │
│   │ (DO/KV)     │  │ (D1)        │                        │
│   │ OCC 写入    │  │ SQL 查询    │                        │
│   │ 实体持久化  │  │ 翻页/过滤   │                        │
│   └────────────┘  └──────────────┘                        │
│                                                            │
│   写入路径: Service → AtomicStore.set() → D1(async sync)    │
│   查询路径: Service → Drizzle ORM → D1                     │
│   AtomicStore 始终是权威源，D1 是只读查询副本                │
└────────────────────────────────────────────────────────────┘
```

---

## Schema 设计

### 核心表

```sql
-- ─── 权限系统 ───
-- 核心查询路径：checkRouteAccess + checkPermission，每次请求跑

CREATE TABLE policy (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  effect    TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  actions   TEXT NOT NULL,        -- JSON array
  resource  TEXT,
  priority  INTEGER NOT NULL DEFAULT 0,
  enabled   INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_policy_priority ON policy(priority DESC);

CREATE TABLE user_group (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  member_ids  TEXT NOT NULL DEFAULT '[]',  -- JSON array of userId
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE perm_group (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  rules          TEXT NOT NULL,          -- JSON: PermissionRule[]
  user_group_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array
  user_ids       TEXT NOT NULL DEFAULT '[]',  -- JSON array
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE route_acl (
  id            TEXT PRIMARY KEY,
  method        TEXT NOT NULL,
  path_prefix   TEXT NOT NULL,
  match_type    TEXT NOT NULL DEFAULT 'prefix',
  effect        TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  user_group_id TEXT,
  user_id       TEXT,
  priority      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_route_acl_priority ON route_acl(priority DESC);

-- ─── 沙箱 ───

CREATE TABLE sandbox (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK(status IN ('Pending','Scheduling','Running','Stopped','Terminated','Failed','Deleted')),
  creator_id  TEXT,
  provider_id TEXT,
  config      TEXT NOT NULL,        -- JSON: full SandboxConfig
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_sandbox_status ON sandbox(status);
CREATE INDEX idx_sandbox_creator ON sandbox(creator_id);

-- ─── 数据卷 ───

CREATE TABLE volume (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK(type IN ('NFSVolume','HostPathVolume','EmptyDirVolume','DiskVolume','ConfigMapVolume','SecretVolume')),
  status      TEXT NOT NULL DEFAULT 'Detached',
  description TEXT,
  nfs         TEXT,              -- JSON: NFSVolumeConfig (nullable)
  disk        TEXT,              -- JSON: DiskVolumeConfig
  config_map  TEXT,              -- JSON: ConfigMapVolumeConfig
  secret      TEXT,              -- JSON: SecretVolumeConfig
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- ─── 用户（只读镜像）───

CREATE TABLE user (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'Viewer',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_user_email ON user(email);
```

### Drizzle Schema 定义

```ts
// src/core/d1/schema/policy.ts
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

export const policies = sqliteTable('policy', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  effect: text('effect', { enum: ['allow', 'deny'] }).notNull(),
  actions: text('actions').notNull(),  // JSON string
  resource: text('resource'),
  priority: integer('priority').notNull().default(0),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => ({
  priorityIdx: index('idx_policy_priority').on(t.priority),
}));

// src/core/d1/schema/route-acl.ts
export const routeAcls = sqliteTable('route_acl', {
  id: text('id').primaryKey(),
  method: text('method').notNull(),
  pathPrefix: text('path_prefix').notNull(),
  matchType: text('match_type').notNull().default('prefix'),
  effect: text('effect', { enum: ['allow', 'deny'] }).notNull(),
  userGroupId: text('user_group_id'),
  userId: text('user_id'),
  priority: integer('priority').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => ({
  priorityIdx: index('idx_route_acl_priority').on(t.priority),
}));
```

---

## 双写策略

### 方案：AtomicStore 权威 + D1 异步更新

```
Service.create()/update()/delete()
       │
       ├──→ AtomicStore.transact()  ← OCC，始终成功
       │
       └──→ Drizzle ORM → D1  ← fire-and-forget，失败不影响主流程
```

```ts
// 双写辅助函数
async function syncToD1(
  query: IQueryStore,
  sql: string,
  params: unknown[],
): Promise<void> {
  query.execute(sql, params).catch((err) =>
    console.warn('[d1-sync] write failed:', err),
  );
}

// 业务代码中
async create(input: CreatePolicyInput): Promise<StoredPolicy> {
  // 1. AtomicStore 写入（OCC 事务，权威源）
  const policy = await this.#policyMgr.create(input, actor);

  // 2. D1 异步同步（失败不阻塞响应）
  syncToD1(this.query,
    `INSERT INTO policy (id, name, effect, actions, resource, priority, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [policy.id, policy.name, policy.effect, JSON.stringify(policy.actions),
     policy.resource, policy.priority, policy.enabled ? 1 : 0,
     policy.createdAt, policy.updatedAt],
  );

  return policy;
}
```

**优势**：
- AtomicStore 始终是权威源，D1 故障不丢数据
- 写入路径不变（OCC 事务保护）
- D1 同步异步执行，不增加响应延迟

**权衡**：
- D1 最终一致（最多滞后几百毫秒）
- 同步代码散落在各处（可用 AOP / 装饰器简化）

---

## 迁移顺序

```
Phase 1                    Phase 2                    Phase 3
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│ Route ACL 检查    │      │  Permission       │      │  Sandbox         │
│                   │      │  check()          │      │  翻页 + 过滤     │
│ 当前: 全量 list() │      │                   │      │                  │
│       O(n) scan   │      │  当前: 3 次全量    │      │  当前: 全量 list │
│                   │      │       list()      │      │       + 内存过滤 │
│ D1: ORDER BY      │      │  D1: SQL JOIN     │      │  D1: WHERE +     │
│     + LIMIT 1     │      │       + WHERE     │      │       LIMIT      │
│ 收益: 极高        │      │  收益: 高          │      │  收益: 中        │
└──────────────────┘      └──────────────────┘      └──────────────────┘
```

### Phase 1 具体步骤

1. `npm install drizzle-orm drizzle-kit`
2. 创建 `src/core/d1/schema/` 下 route-acl 的 Drizzle schema
3. 配置 `drizzle.config.ts`，指向本地 SQLite
4. `npx drizzle-kit push` 生成本地 SQLite 测试库
5. 修改 `RouteAclManager.checkAccess()`：先用 Drizzle 查 D1，查不到退化到 AtomicStore
6. 在 PermissionService 的 create/update/delete route ACL 中加双写
7. `npx drizzle-kit generate` 生成迁移 SQL，部署到生产 D1

### 不会迁到 D1 的实体

| 实体 | 理由 |
|---|---|
| session | 纯 KV：按 token 精确查找，无 SQL 需求 |
| template | 低频，DAG 解析需要全量加载 |
| sysgroup | 静态种子数据，全量 cached |
| instance/credential/bucket | 低频 CRUD |

---

## Drizzle 配置

```ts
// drizzle.config.ts
import type { Config } from 'drizzle-kit';

export default {
  schema: './src/core/d1/schema/*.ts',
  out: './src/core/d1/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: '.data/d1/db.sqlite',  // 本地开发用 SQLite
  },
} satisfies Config;
```

### 开发流程

```bash
# 1. schema → 本地 SQLite
npx drizzle-kit push

# 2. schema 变更后生成迁移
npx drizzle-kit generate

# 3. 将迁移 SQL 应用到远程 D1
npx wrangler d1 migrations apply HBI_AAD_DB --remote

# 4. Drizzle Studio（可视化数据浏览）
npx drizzle-kit studio
```

### 运行时初始化

```ts
// src/core/d1/db.ts
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

export function createD1Client(d1: D1Database) {
  return drizzle(d1, { schema });
}
```

---

## 关键决策

1. **ORM 选择**：Drizzle ORM 而不是 MikroORM——唯一原生支持 D1 的 ORM，workerd 零兼容问题
2. **权威源**：AtomicStore 始终是写入权威源，D1 是只读查询副本
3. **同步策略**：fire-and-forget 异步双写，失败不阻塞主流程
4. **不回迁**：纯 KV 场景（session、idempotency key、单 key 读写）保留在 AtomicStore
5. **Phase 1 切入点**：Route ACL 检查——最痛的点（每次请求全量扫描），改造成本最低
