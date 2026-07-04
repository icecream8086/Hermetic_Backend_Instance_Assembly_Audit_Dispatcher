# OCC 冲突修复指南

> **背景**: Worker 请求必须在 30s 内完成。OCC `get→modify→set` 在并发场景下会版本冲突，冲突后必须重试（立即重试，不用 sleep）。
> **原则**: 索引类操作用 3 次重试 + `Promise.race` 短超时；实体类操作用 `transact` 替代手动 OCC。

---

## 修复模式

### 模式 A — 索引操作：加 3 次立即重试

适用于 `get<string[]>` → 数组操作 → `set` 的索引追加/删除：

```typescript
// 旧（冲突时静默丢数据）:
const idx = await atomic.get<string[]>(INDEX_KEY);
await atomic.set(INDEX_KEY, [...(idx?.value ?? []), newId], idx?.version ?? null);

// 新（3 次重试）:
for (let attempt = 0; attempt < 3; attempt++) {
  const idx = await atomic.get<string[]>(INDEX_KEY);
  const ok = await atomic.set(INDEX_KEY, [...(idx?.value ?? []), newId], idx?.version ?? null);
  if (ok) break;
}
```

不要用 sleep、backoff 或指数退避。Worker 里直接立即重试——DO 在同一实例内，版本冲突的概率低，3 次就够。

### 模式 B — 实体更新：改用 `transact`

适用于 `get<Entity>` → 修改实体字段 → `set` 的模式：

```typescript
// 旧（冲突时静默丢数据）:
const entry = await atomic.get<Entity>(key);
if (!entry) return;
const updated = { ...entry.value, field: newValue, updatedAt: Date.now() };
await atomic.set(key, updated, entry.version);

// 新（transact 保证原子性）:
await atomic.transact(async (txn) => {
  const entry = await txn.get<Entity>(key);
  if (!entry) return;
  txn.set(key, { ...entry, field: newValue, updatedAt: Date.now() });
});
```

`transact` 内部所有操作串行化，不存在版本冲突。不用手动管理 OCC 版本。

---

## 修复清单

### 1. `src/core/images/image-cache.ts` — 全部变异方法

| 方法 | 行 | 模式 | 修法 |
|---|---|---|---|
| `recordAccess` | 56-68 | B（读实体→改→写回） | `transact` |
| `recordRemoval` | 86-91 | B（读实体→删） | `transact` |
| `touch` | 95-99 | B（读实体→改 lastAccessedAt→写回） | `transact` |
| `#addToIndex` | 158-160 | A（数组追加） | 3 次重试 |
| `#removeFromIndex` | 163-166 | A（数组过滤） | 3 次重试 |

**已有参考**: `#addToTotalSize`（169-177 行）已正确实现 3 次重试，照抄即可。

---

### 2. `src/core/auth/credential.ts` — 索引操作

| 方法 | 行 | 模式 | 修法 |
|---|---|---|---|
| `#addToIndex` | 265-267 | A（数组追加） | 3 次重试 |
| `#removeFromIndex` | 270-273 | A（数组过滤） | 3 次重试 |

`credential.ts` 的 `update` 方法（221-246 行）已正确处理冲突（抛 409），index 方法参照它加重试。

---

### 3. `src/core/pod/store.ts` — 索引操作

| 方法 | 行 | 模式 | 修法 |
|---|---|---|---|
| `addToIndex` | 46-49 | A（数组追加） | 3 次重试 |
| `removeFromIndex` | 51-54 | A（数组过滤） | 3 次重试 |

`PodStore.update`（63-65 行）已正确抛 409，只用修 index 两个方法。

---

### 4. `src/core/audit/hybrid-logger.ts` — `#persistToStore`

| 方法 | 行 | 模式 | 修法 |
|---|---|---|---|
| `#persistToStore` 索引更新 | 140-145 | A（数组 shift+push） | 3 次重试 |
| `prune` 逐条删除 | 183-212 | B（读→set null） | `transact` 或 3 次重试 |

---

## 执行顺序

无依赖，4 个文件独立。可以并行修。

## 验证

```bash
npm run typecheck   # 每个文件修完后单独跑
npm run lint
```

## 变更量

| 文件 | 改动行数 |
|---|---|
| `image-cache.ts` | ~20 行 |
| `credential.ts` | ~10 行 |
| `pod/store.ts` | ~10 行 |
| `hybrid-logger.ts` | ~15 行 |
| **合计** | **~55 行** |
