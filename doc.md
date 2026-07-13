# CleanupPoller — 后台周期性清理机制

> 原 doc.md §1-8（沙箱生命周期设计）已实现，归档。
> §9 CleanupPoller 为未实现设计，跟踪 ISSUE-00021。

## 9.1 设计目标

系统中存在多类"垃圾"需要后台周期性扫描并清理，不应依赖人工触发：

- **僵尸 Sandbox**：状态为 Terminated/Failed 超过 N 小时但未 Deleted
- **僵尸 DNS 记录**：指向已不存在 Sandbox 的 Active DNS 记录
- **过期 MetricSnapshot**：超过保留期的监控采样数据
- **孤立 Event**：关联的 Sandbox 已删除但 Event 摘要仍保留
- **半创建 Sandbox**：状态为 Pending/Scheduling 超过超时阈值（创建卡住）

## 9.2 接口定义

```typescript
interface ICleanupTask {
  /** 任务名称，用于日志 */
  readonly name: string;
  /** 扫描候选对象，返回需要清理的 ID 列表 */
  scan(): Promise<string[]>;
  /** 对单个候选对象执行清理，返回是否成功 */
  cleanup(id: string): Promise<boolean>;
  /** 扫描间隔（毫秒） */
  readonly intervalMs: number;
  /** 单次清理的上限，防止雪崩 */
  readonly batchLimit: number;
}

interface ICleanupPoller {
  /** 注册清理任务 */
  register(task: ICleanupTask): void;
  /** 启动轮询（在 createApp 时调用） */
  start(): void;
  /** 停止轮询并等待当前批次完成 */
  stop(): Promise<void>;
}
```

## 9.3 预设清理任务

| 任务 | 扫描条件 | 清理动作 | 间隔 | batchLimit |
|------|---------|---------|------|------------|
| `zombie-sandbox` | Terminated/Failed 且 `updatedAt` 超过 6h | 调用 DeleteContainerGroup，标记为 Deleted | 30min | 10 |
| `stale-dns` | DNS Active 但关联 sandboxId 状态为 Deleted/Terminated | 删除 Cloudflare DNS 记录 | 30min | 20 |
| `expired-metrics` | MetricSnapshot 时间戳超过 30d | 通过 IBlobStore.delete 删除 | 24h | 100 |
| `stuck-provision` | Pending/Scheduling 且 `createdAt` 超过 15min | 标记为 Failed，记录告警日志 | 5min | 5 |

## 9.4 实现约束

- **单次批量上限**：每个任务每轮最多处理 `batchLimit` 条，分批推进，防止 API 限流
- **清理幂等**：`cleanup()` 可能被重入，必须判断当前状态再执行
- **失败不阻塞**：单条清理失败记录日志后继续处理下一条
- **审计日志**：每次清理动作写入 LogEntry（facility: `cleanup-poller`）
- **分布式互斥**：多实例时通过 `IAtomicStore.set()` 获取清理租约（key: `cleanup:lease:{taskName}`），避免重复执行
- **stop 等待**：`stop()` 必须等待当前执行中的清理批次完成

## 9.5 集成点

```typescript
// src/cron/cleanup.ts
export function createCleanupPoller(stores: Stores, logRouter: ILogRouter): ICleanupPoller { ... }

// src/index.ts
const poller = createCleanupPoller(stores, logRouter);
poller.register(zombieSandboxTask);
poller.register(staleDnsTask);
poller.start();
```

---

> 跟踪: ISSUE-00021
> 现有部分 GC: `src/core/events/health-check.ts` — 未覆盖完整 CleanupPoller 设计
