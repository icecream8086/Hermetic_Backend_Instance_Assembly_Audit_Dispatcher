# 游戏服务器沙箱系统 · 对象生命周期建模

> 基于 `catch/script0/` 八个阿里云 ECI 运维脚本提炼，用于指导 `HBI-AAD` 后端开发。

---

## 1. 领域总览

- **Sandbox** (ContainerGroup) — 核心聚合根，包含 Container[]、VolumeMount[]、Network、Tag[]、Event[]
- **Container** — Sandbox 子实体，镜像 `registry-vpc.../steamcmd_runtime`，挂载 NFS 卷
- **Volume** — NFS/NAS 数据卷，独立于 Sandbox 存在
- **DnsRecord** — Cloudflare A 记录，指向 Sandbox 公网 IP
- **MetricSnapshot** — 60s 周期的监控采样，不可变

---

## 2. Sandbox 生命周期（核心状态机）

### 2.1 状态定义

```typescript
enum SandboxStatus {
  Pending       = 'Pending',        // API 已接受，等待调度
  Scheduling    = 'Scheduling',     // 调度中（中间态）
  Running       = 'Running',        // 正常运行
  Stopped       = 'Stopped',        // 手动停止
  Terminated    = 'Terminated',     // Spot 回收 / 异常终止
  Failed        = 'Failed',         // 创建失败
  Deleted       = 'Deleted',        // 已删除（逻辑删除）
}
```

### 2.2 状态转移规则

| 触发操作 | 源状态 | 目标状态 | 前置条件 | 副作用 |
|---------|--------|---------|---------|--------|
| `provision()` | — | Pending | 无 | 创建 ECI 请求 |
| 调度成功 | Pending | Running | 阿里云调度完成 | 写入 containerGroupId |
| 调度中 | Pending | Scheduling | — | 等待事件 |
| 调度失败 | Pending | Failed | — | 记录失败原因 |
| `stop()` | Running | Stopped | — | 保留磁盘/IP |
| Spot 回收 | Running | Terminated | SpotStrategy=SpotAsPriceGo | 丢失临时磁盘 |
| `terminate()` | Running/Stopped | Deleted | — | 释放所有资源 |
| 手动删除 | 任意非终态 | Deleted | — | 调用 DeleteContainerGroup |

### 2.3 终态定义

- **Deleted**：不可逆终态，资源已释放
- **Failed**：可重试终态（用户可重新 `provision`）
- **Terminated**：被动终态（被云平台回收，可重新 `provision`）

---

## 3. 子对象生命周期

### 3.1 Container（容器）

Container 是 Sandbox 的子实体，生命周期嵌在 Sandbox 内：

`ImagePulling -> ImagePulled -> Created -> Started -> Running`，任何阶段可进入 `Failed`（镜像拉取失败）。

**关键字段**：
- `Ready: boolean` — 容器是否就绪
- `RestartCount: number` — 重启次数（用于判断稳定性）
- `CurrentState.State` — 当前运行状态（Running/Waiting/Terminated）
- `CurrentState.StartTime` — 启动时间

**设计原则**：Container 不单独建模为聚合根，它是 Sandbox 的一部分。查询 Container 状态统一走 Sandbox。

### 3.2 Volume（数据卷）

Volume 生命周期**独立于 Sandbox**。NAS 卷在 Sandbox 删除后依然存在：

`Detached -> Attached（挂载到 Sandbox）-> Detached（Sandbox 删除）-> Orphaned`

**关键属性**：
- `Type: 'NFSVolume'` — 当前只使用 NFS
- `Server` / `Path` — NAS 挂载地址
- `ReadOnly` — 游戏固件 (gamebin/sdk) 只读，地图 (map) 可读写

**设计原则**：Volume 是独立实体。Sandbox 通过 VolumeMount 引用 Volume。

### 3.3 Event（事件）

Event 是**只追加、不可变**的日志：

- **Normal**: Pulling, Pulled, Created, Started, SuccessfulHitImageCache
- **Warning**: FailedCreatePodSandBox, FailedMount, Unhealthy

**关键字段**：
- `Reason` / `Type` / `Message` — 事件分类
- `Count` — 重复次数（K8s 会对重复事件计数而非创建新事件）
- `LastTimestamp` — 最后发生时间

**设计原则**：Event 不单独持久化，它是 ECI API 返回的快照数据。如需审计，通过 `IAtomicStore` 存储事件摘要。

---

## 4. DNS 记录生命周期

Cloudflare DNS A 记录指向 Sandbox 的公网 IP，状态机：

`Stale（无 IP）-> Active（指向最新 IP）-> Stale（IP 已失效）`

**关键行为**（来自 `alibaba_l4d2_runtime_test.py`）：
1. Sandbox 创建后，轮询公网 IP（每 10s，最多 3min）
2. 获取到 IP 后调用 Cloudflare API 更新 DNS
3. Sandbox 删除时，DNS 记录应清理或指向 fallback

**轮询超时处理**：3 分钟后仍未获得 IP -> Sandbox 标记为 `Degraded`，触发告警。

---

## 5. MetricSnapshot 生命周期（不可变采样）

`Sampled（API 拉取）-> Immutable（只读，用于图表）`

- 每条 MetricSnapshot 对应一个时间点的全量指标（CPU/内存/网络/磁盘/IOPS）
- **不可变**：一旦采样即不可修改
- **可归档**：过期采样通过 `IBlobStore` 归档
- **周期**：60s（Period 参数），来自 `DescribeContainerGroupMetric`

---

## 6. 聚合根与仓储映射

| 聚合根 | 存储层 | 关键索引 |
|--------|-------|---------|
| **Sandbox** | `IAtomicStore` | `sandbox:{id}` -> 状态 + 网络信息 |
| **Volume** | `IAtomicStore` | `volume:{name}` -> NFS 配置 |
| **DnsRecord** | `IAtomicStore` | `dns:{domain}` -> 当前 IP + 记录 ID |
| **MetricSnapshot** | `IBlobStore`（归档） | 按 sandboxId + 时间范围 |

Sandbox 的状态变更必须走 `IAtomicStore` 的乐观锁（`expectedVersion`），防止并发修改冲突。

---

## 7. 状态转移的实现约束

1. **所有状态转移必须经过验证**：`SandboxService.transition(sandboxId, targetStatus)` 在执行阿里云 API 调用前检查当前状态是否允许该转移。

2. **乐观锁**：更新 Sandbox 状态使用 `IAtomicStore.set(key, value, expectedVersion)`，冲突时重试。

3. **幂等**：`provision` 操作支持 `Idempotency-Key`，避免重复创建 Sandbox。

4. **审计日志**：每次状态转移记录 `LogInput`，facility 为 `sandbox-provisioner`，元数据包含 `{ sandboxId, fromStatus, toStatus, requestId }`。

5. **DNS 更新异步化**：Sandbox 创建后，轮询 IP 并更新 DNS 是异步过程，不应阻塞 `provision` 的 HTTP 响应。通过 cron 或后台任务处理。

---

## 8. 服务边界

`features/sandbox/` 目录结构：

- `sandbox.service.ts` — 核心生命周期管理：`provision()`（Pending->Running）、`stop()`（Running->Stopped）、`terminate()`（*->Deleted）、`getStatus()`
- `sandbox.dns.service.ts` — DNS 管理：`pollIp()`（轮询公网 IP）、`updateDns()`（更新 Cloudflare 记录）
- `sandbox.metrics.service.ts` — 监控数据：`fetchMetrics()`（拉取采样）、`archiveMetrics()`（归档过期数据）
- `sandbox.log.service.ts` — 日志查询：`getLogs()`（查询容器日志）

---

## 9. CleanupPoller — 轮询清理机制（未实现）

### 9.1 设计目标

系统中存在多类"垃圾"需要后台周期性扫描并清理，不应依赖人工触发：

- **僵尸 Sandbox**：状态为 Terminated/Failed 超过 N 小时但未 Deleted
- **僵尸 DNS 记录**：指向已不存在 Sandbox 的 Active DNS 记录
- **过期 MetricSnapshot**：超过保留期的监控采样数据
- **孤立 Event**：关联的 Sandbox 已删除但 Event 摘要仍保留
- **半创建 Sandbox**：状态为 Pending/Scheduling 超过超时阈值（创建卡住）

### 9.2 接口定义

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

### 9.3 预设清理任务

| 任务 | 扫描条件 | 清理动作 | 间隔 | batchLimit |
|------|---------|---------|------|------------|
| `zombie-sandbox` | Terminated/Failed 且 `updatedAt` 超过 6h | 调用阿里云 DeleteContainerGroup，标记为 Deleted | 30min | 10 |
| `stale-dns` | DNS Active 但关联 sandboxId 状态为 Deleted/Terminated | 删除 Cloudflare DNS 记录 | 30min | 20 |
| `expired-metrics` | MetricSnapshot 时间戳超过 30d | 通过 IBlobStore.delete 删除 | 24h | 100 |
| `stuck-provision` | Pending/Scheduling 且 `createdAt` 超过 15min | 标记为 Failed，记录告警日志 | 5min | 5 |

### 9.4 实现约束

- **单次批量上限**：每个任务每轮最多处理 `batchLimit` 条，分批推进，防止阿里云 API 限流
- **清理幂等**：`cleanup()` 可能被重入（上次批处理中断），必须判断当前状态再执行
- **失败不阻塞**：单条清理失败记录日志后继续处理下一条，不中断整批
- **审计日志**：每次清理动作写入 LogEntry（facility: `cleanup-poller`），包含清理原因、对象 ID、结果
- **分布式互斥**：生产环境多实例时，通过 `IAtomicStore.set()` 获取清理租约（key: `cleanup:lease:{taskName}`），避免重复执行
- **stop 等待**：`stop()` 必须等待当前正在执行的清理批次完成，不能强行中断

### 9.5 集成点

```typescript
// src/cron/cleanup.ts
export function createCleanupPoller(stores: Stores, logRouter: ILogRouter): ICleanupPoller { ... }

// src/index.ts
const poller = createCleanupPoller(stores, logRouter);
poller.register(zombieSandboxTask);
poller.register(staleDnsTask);
poller.start();
```
