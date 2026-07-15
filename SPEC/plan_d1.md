# D1 + AtomicStore 双写迁移计划

## 目录

- [背景](#背景)
- [架构](#架构)
- [Schema 设计](#schema-设计)
- [双写策略](#双写策略)
- [迁移顺序](#迁移顺序)
- [不会迁到 D1 的实体](#不会迁到-d1-的实体)
- [关键决策](#关键决策)

---

## 背景

当前项目使用 3 层存储：

| 层 | 后端 | 用途 |
|---|---|---|
| IAtomicStore | DO / KV / file | OCC 状态，实体读写 |
| IQueryStore | D1 / file / none | 关系查询，翻页，过滤 |
| IBlobStore | R2 / file / none | 二进制大对象 |

`IQueryStore` 目前几乎未被业务代码使用——所有查询走 AtomicStore 的全量扫描 + 内存过滤，每次请求都 O(n) 遍历所有 route ACL / perm group / user group。

---

## 架构

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
│   │ AtomicStore │  │ D1 (裸 SQL)  │                        │
│   │ (DO/KV)     │  │              │                        │
│   │ OCC 写入    │  │ SQL 查询     │                        │
│   │ 实体持久化  │  │ 翻页/过滤    │                        │
│   └────────────┘  └──────────────┘                        │
│                                                            │
│   写入路径: Service → AtomicStore.set() → D1 (async sync)   │
│   查询路径: Service → D1 → 返回                             │
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

---

## 双写策略

### 方案：AtomicStore 权威 + D1 异步更新

```
Service.create()/update()/delete()
       │
       ├──→ AtomicStore.transact()  ← OCC，始终成功
       │
       └──→ D1 异步写入  ← fire-and-forget，失败不影响主流程
```

```typescript
// 双写辅助函数
async function syncToD1(
  db: D1Database,
  sql: string,
  params: unknown[],
): Promise<void> {
  db.prepare(sql).bind(...params).run()
    .catch((err) => console.warn('[d1-sync] write failed:', err));
}

// 业务代码中
async create(input: CreatePolicyInput): Promise<StoredPolicy> {
  // 1. AtomicStore 写入（OCC 事务，权威源）
  const policy = await this.#policyMgr.create(input, actor);

  // 2. D1 异步同步（失败不阻塞响应）
  syncToD1(this.db,
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
- 同步代码散落在各处

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

1. 创建 `route_acl` 表的 DDL
2. 配置 `wrangler.toml` D1 migration
3. 修改 `RouteAclManager.checkAccess()`：先查 D1，查不到退化到 AtomicStore
4. 在 RouteAclManager 的 create/update/delete 中加双写
5. `npx wrangler d1 execute` 执行建表 SQL，部署到生产 D1

### Phase 2 具体步骤

1. 创建 `policy`、`user_group`、`perm_group` 表
2. 修改 `PermissionChecker`：用 D1 JOIN 替代 3 次全量 list
3. 在 PermissionService 的 create/update/delete 中加双写

### Phase 3 具体步骤

1. 创建 `sandbox`、`volume` 表
2. 修改 `SandboxService.list()`：D1 WHERE + ORDER BY + LIMIT/OFFSET 替代内存过滤
3. 在 SandboxService 的 create/update/delete 中加双写

---

## 不会迁到 D1 的实体

| 实体 | 理由 |
|---|---|
| session | 纯 KV：按 token 精确查找，无 SQL 需求 |
| template | 低频，DAG 解析需要全量加载 |
| sysgroup | 静态种子数据，全量 cached |
| instance/credential/bucket | 低频 CRUD |

---

## 关键决策

1. **权威源**：AtomicStore 始终是写入权威源，D1 是只读查询副本
2. **同步策略**：fire-and-forget 异步双写，失败不阻塞主流程
3. **不回迁**：纯 KV 场景（session、idempotency key、单 key 读写）保留在 AtomicStore
4. **Phase 1 切入点**：Route ACL 检查——最痛的点（每次请求全量扫描），改造成本最低
5. **底层索引**：D1 不必须存完整实体副本，可只存索引列 + AtomicStore key 作为指针层（详见 `D1_AS_INDEX_LAYER.md`）
6. **D1 缓存**：低写入频率实体可完全用 D1 缓存模式，省略双写——读 miss 时从 AtomicStore 回填（详见 `D1_CACHE_STRATEGY.md`）
