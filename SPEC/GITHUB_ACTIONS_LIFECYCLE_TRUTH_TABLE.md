# GitHub Actions Workflow Run —— 真值表

> **数据源**: `https://unpkg.com/@github/openapi@5.7.2/dist/api.github.com.json`
> **生成时间**: 2026-06-24

---

## 真值表约定

- **V** = 合法操作（API 返回 2xx）
- **I** = 非法操作（API 返回 4xx，状态不变）
- **—** = 该事件在当前状态下不可能发生
- **软终态** = `completed`——可通过 `rerun` 回到 `queued`
- **硬终态** = `deleted`——资源不可逆移除

---

## 转移函数形式化定义

$$\delta: \mathbb{S}_{\text{run}} \times \Omega \to \mathbb{S}_{\text{run}}$$

其中：

$$\Omega = \{ \text{Dispatch}, \text{Cancel}, \text{Rerun}, \text{RerunFailed}, \text{Delete}, \text{SystemDequeue}, \text{SystemAssign}, \text{SystemWait}, \text{SystemResume}, \text{SystemComplete}, \text{SystemTimeout}, \text{SystemStale} \}$$

---

## 表 1: 完整 Run 状态 × 操作真值矩阵

| 当前状态 $s$ | Dispatch (新建) | CancelRun | RerunRun | RerunFailed | DeleteRun | 系统:出队 | 系统:分配Runner | 系统:等待 | 系统:恢复 | 系统:完成 | 系统:超时 | 系统:过时 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **(无)** | `queued` | I | I | I | I | — | — | — | — | — | — | — |
| **queued** | I | `completed`(cancelled) | I | I | `deleted` | `pending` | — | — | — | — | — | — |
| **pending** | I | `completed`(cancelled) | I | I | `deleted` | — | `in_progress` | `waiting` | — | — | — | `completed`(stale) |
| **requested** | I | `completed`(cancelled) | I | I | `deleted` | — | `pending` | — | — | — | — | — |
| **waiting** | I | `completed`(cancelled) | I | I | `deleted` | — | — | — | `pending` | — | — | `completed`(stale) |
| **in_progress** | I | `completed`(cancelled) | I | I | `deleted` | — | — | — | — | `completed` | `completed`(timed_out) | `completed`(stale) |
| **completed** | `queued`† | I | `queued` | `in_progress` | `deleted` | — | — | — | — | — | — | — |
| **deleted** | I | I | I | I | I | — | — | — | — | — | — | — |

† `Dispatch` 创建的是**新** run（新 run_id），不是修改当前 run。但当 run 处于 `completed` 时，可通过 `RerunRun` 回到 `queued`（同一 run_id）。

### 终态判定公式

$$\text{IsHardTerminal}(s) \triangleq s = \text{deleted}$$

$$\forall s \in \mathbb{S}_{\text{run}}: \text{IsHardTerminal}(s) \implies \forall \omega \in \Omega: \delta(s, \omega) = s$$

$$\text{IsSoftTerminal}(s) \triangleq s = \text{completed}$$

$$\delta(\text{completed}, \omega) \in \{ \text{queued}, \text{in\\\_progress}, \text{deleted} \} \quad \text{for valid } \omega$$

---

## 表 2: API 前置条件与后置条件真值表

| # | 操作 | 前置条件 | 后置条件（成功时） | 违反前置条件时的 HTTP 错误 |
|---|---|---|---|---|
| 1 | `CreateDispatch` | 有效 workflow_id；有权触发 workflow；workflow 含 `workflow_dispatch` 事件 | $s = \text{queued}$（新 run）；返回 204 No Content | `404 Not Found`（workflow 不存在）、`422 Unprocessable` |
| 2 | `CancelRun` | $s \in \{ \text{queued}, \text{pending}, \text{requested}, \text{waiting}, \text{in\\\_progress} \}$；有效 run_id | $s = \text{completed}$；$\text{conc} = \text{cancelled}$ | `404 Not Found`、`409 Conflict`（已 completed） |
| 3 | `RerunRun` | $s = \text{completed}$；有效 run_id | $s = \text{queued}$（同一 run_id 重新入队）；$\text{conc} = \text{null}$ | `404 Not Found`、`403 Forbidden`（无权限） |
| 4 | `RerunFailedJobs` | $s = \text{completed}$ 且 $\text{conc} = \text{failure}$；有效 run_id | $s = \text{in\\\_progress}$（仅重跑失败 job） | `404 Not Found`、`403 Forbidden`、`422`（无失败 job） |
| 5 | `DeleteRun` | $\text{run\\\_id}$ 存在且未被删除 | $s = \text{deleted}$（资源不可逆移除）；返回 204 | `404 Not Found`（已 deleted 或不存在） |
| 6 | `GetRun` | 有效 run_id | 返回 run 完整信息（status, conclusion, jobs_url 等） | `404 Not Found` |
| 7 | `ListRuns` | 有效 repo | 返回 run 列表（支持 status/conclusion/branch/actor/event 过滤，每页 max 100） | `404 Not Found`（repo 不存在） |
| 8 | `GetJob` | 有效 job_id | 返回 job 完整信息（status, conclusion, steps, started_at, completed_at） | `404 Not Found` |
| 9 | `ListJobsForRun` | 有效 run_id | 返回该 run 下所有 job 列表（每页 max 100） | `404 Not Found` |

---

## 表 3: 系统驱动转移真值表

| # | 源状态 | 系统条件 | 目标状态 | 可逆？ |
|---|---|---|---|---|
| G1 | `queued` | 进入队列成功 | `pending` | 否（仅向前） |
| G2 | `pending` | GitHub 分配 runner 成功 | `in_progress` | 否 |
| G3 | `pending` | 等待外部条件（如 deployment approval） | `waiting` | 是（waiting → pending） |
| G4 | `waiting` | 外部条件满足 | `pending` | 是 |
| G5 | `in_progress` | 所有 job 完成 | `completed`（conclusion 由 job 结果聚合） | 是（通过 rerun） |
| G6 | `in_progress` | workflow 超时 | `completed`（conclusion=`timed_out`） | 是（通过 rerun） |
| G7 | `in_progress` | 新 commit 推送到同一分支/PR | `completed`（conclusion=`stale`） | 否（旧 run 不再有效，应 rerun 新 commit） |
| G8 | `pending` | 新 commit push（取消排队） | `completed`（conclusion=`stale`） | 否 |
| G9 | `waiting` | 新 commit push | `completed`（conclusion=`stale`） | 否 |

---

## 表 4: Conclusion 聚合真值表 (Run ← Jobs)

Workflow run 的 conclusion 如何由其所有 job 决定。

| 条件 | Run Conclusion |
|---|---|
| $\forall j: \text{conc}(j) = \text{success}$ | `success` |
| $\exists j: \text{conc}(j) = \text{failure}$ | `failure` |
| CancelRun 被调用 | `cancelled` |
| $\forall j: \text{conc}(j) = \text{skipped}$ | `skipped` |
| 超时触发 | `timed_out` |
| $\exists j: \text{conc}(j) = \text{action\\\_required}$ | `action_required` |
| $\forall j: \text{conc}(j) \in \{ \text{success}, \text{neutral}, \text{skipped} \}$ 且非全 skipped | `neutral` |
| 新 commit 覆盖 | `stale` |

### Job → Steps 聚合

| 条件 | Job Conclusion |
|---|---|
| $\forall \text{step}: \text{conc}(\text{step}) = \text{success}$ | `success` |
| $\exists \text{step}: \text{conc}(\text{step}) = \text{failure}$（非 continue-on-error） | `failure` |
| $\exists \text{step}: \text{conc}(\text{step}) = \text{failure}$（continue-on-error=true） | 继续执行，最终可能为 `success` |
| 父 run 被 cancel | `cancelled` |
| if 条件 `false`（跳过整个 job） | `skipped` |
| 超时 | `timed_out` |

---

## 表 5: CancelRun 合法性真值表

CancelRun 可在 Run 处于任何非终态时被调用。

| $s$ | CancelRun 合法？ | 结果 |
|---|---|---|
| `queued` | V | `completed` (conclusion=`cancelled`) |
| `pending` | V | `completed` (conclusion=`cancelled`) |
| `requested` | V | `completed` (conclusion=`cancelled`) |
| `waiting` | V | `completed` (conclusion=`cancelled`) |
| `in_progress` | V | `completed` (conclusion=`cancelled`) |
| `completed` | I ($409$ Conflict) | 状态不变 |
| `deleted` | I ($404$ Not Found) | N/A |

---

## 表 6: RerunRun × RerunFailedJobs 真值表

| 操作 | 前置 $s$ | 前置 conc | 效果 | 新 $s$ |
|---|---|---|---|---|
| `RerunRun` | `completed` | 任意 | 全部 job 重置，run 重新入队 | `queued` |
| `RerunRun` | 非 `completed` | — | 错误: $422$ / $409$ | 不变 |
| `RerunFailedJobs` | `completed` | `failure` | 仅 conc=`failure` 的 job 重置 | `in_progress` |
| `RerunFailedJobs` | `completed` | 非 `failure` | 错误: $422$（无失败 job 可重跑） | 不变 |
| `RerunFailedJobs` | 非 `completed` | — | 错误: $422$ / $409$ | 不变 |

---

## 表 7: 完整状态可达性矩阵

$R(s_i, s_j)$ = 从 $s_i$ 能否到达 $s_j$？ ✓ = 直接可达，→ = 间接可达，✗ = 不可达。

| $s_i \setminus s_j$ | queued | pending | in_prg | reques | wait | compl | deleted |
|---|---|---|---|---|---|---|---|
| **queued** | — | ✓ | → | → | → | → | ✓ |
| **pending** | ✗ | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| **in_progress** | ✗ | ✗ | — | ✗ | ✗ | ✓ | ✓ |
| **requested** | ✗ | ✓ | → | — | → | → | ✓ |
| **waiting** | ✗ | ✓ | → | → | — | ✓ | ✓ |
| **completed** | ✓ | → | ✓ | → | → | — | ✓ |
| **deleted** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | — |

### 关键结论

$$\forall s \in \{ \text{completed} \}: R^*(s) = \mathbb{S}_{\text{run}} \setminus \{ \text{deleted} \}$$

**`completed` 不是硬终态**——可通过 `rerun` 回到 `queued`，再到达任何非 deleted 状态。

$$R^*(\text{deleted}) = \{ \text{deleted} \}$$

**`deleted` 是唯一硬终态**——不可逆，API 返回 404。

---

## 表 8: 幂等性保证真值表

| 操作 | 幂等？ | 机制 |
|---|---|---|
| `CreateDispatch` | 否 | 每次调用创建新 run；无 `ClientToken` 等价物 |
| `CancelRun` | 是（效果上） | 重复 cancel 已 completed 的 run → $409$ Conflict，run 保持 cancelled |
| `RerunRun` | 否 | 每次调用都会重新入队（若已在 queued → 另一份运行） |
| `RerunFailedJobs` | 部分 | 若无失败 job 可重跑 → $422$ |
| `DeleteRun` | 是（效果上） | 重复 delete → $404$ Not Found |
| `GetRun` | 是 | 纯读操作 |
| `ListRuns` | 是 | 纯读操作 |

---

## 表 9: 资源层级与状态蕴含真值表

### Run → Job 蕴含

| Run $s$ | Job 可能的 $s$ |
|---|---|
| `queued` | 全部 `queued` |
| `pending` | 全部 `queued` |
| `in_progress` | `queued` / `in_progress` / `completed` |
| `completed` | 全部 `completed` |
| `deleted` | 全部不可查（404） |

### Job → Step 蕴含

| Job $s$ | Step 可能的 $s$ |
|---|---|
| `queued` | 全部 `queued` |
| `in_progress` | `queued` / `in_progress` / `completed` |
| `completed` | 全部 `completed` |

### 蕴含公式

$$\text{runStatus}(r) = \text{completed} \implies \forall j \in \text{jobs}(r): \text{jobStatus}(j) = \text{completed}$$

$$\text{jobStatus}(j) = \text{in\\\_progress} \implies \text{runStatus}(\text{runOf}(j)) = \text{in\\\_progress}$$

$$\text{jobStatus}(j) = \text{completed} \implies \text{jobConclusion}(j) \neq \text{null}$$

---

## 表 10: 用户可触发 vs GitHub 内部转移

| 转移 | 触发者 | 说明 |
|---|---|---|
| `[*] → queued` | **用户** / GitHub | push / dispatch / schedule / rerun |
| `queued → pending` | GitHub | 自动 |
| `pending → in_progress` | GitHub | 自动（runner 分配） |
| `pending → waiting` | GitHub | 自动（deployment approval 等条件） |
| `waiting → pending` | GitHub | 自动（条件满足） |
| `in_progress → completed` | GitHub | 自动（完成） |
| `in_progress → completed(cancelled)` | **用户** | CancelRun API |
| `in_progress → completed(timed_out)` | GitHub | 自动（超时） |
| `in_progress → completed(stale)` | GitHub | 自动（新 commit） |
| `completed → queued` | **用户** | RerunRun API |
| `completed → in_progress` | **用户** | RerunFailedJobs API |
| `任意 → deleted` | **用户** | DeleteRun API |
| `requested → pending` | GitHub | 内部 |
| `requested → completed(cancelled)` | **用户** | CancelRun API |

`requested` 和 `waiting` 状态仅由 GitHub 内部设置，用户无法直接触发进入这两个状态。

---

## 验证结论

### 安全属性 (Safety)

| # | 属性 | 公式 | 验证 |
|---|---|---|---|
| P1 | 硬终态不可复活 | $s = \text{deleted} \implies \forall \omega: \delta(s, \omega) = s$ | ✓ |
| P2 | Cancel 仅对活跃状态有效 | $\text{Cancel}(r) \text{ success} \implies s(r) \notin \{ \text{completed}, \text{deleted} \}$ | ✓ — completed 返回 409, deleted 返回 404 |
| P3 | Rerun 仅对 completed 有效 | $\text{Rerun}(r) \text{ success} \implies s(r) = \text{completed}$ | ✓ |
| P4 | RerunFailed 仅对 completed + failure 有效 | $\text{RerunFailed}(r) \text{ success} \implies s(r) = \text{completed} \land \text{conc}(r) = \text{failure}$ | ✓ |
| P5 | Conclusion 仅在 completed 时非 null | $\text{conc}(r) \neq \text{null} \implies s(r) = \text{completed}$ | ✓ |
| P6 | Job conclusion 仅在 job completed 时非 null | $\text{conc}(j) \neq \text{null} \implies s(j) = \text{completed}$ | ✓ |
| P7 | Run completed 蕴含所有 job completed | $s(r) = \text{completed} \implies \forall j \in \text{jobs}(r): s(j) = \text{completed}$ | ✓ |

### 活性 (Liveness)

| # | 属性 | 公式 | 验证 |
|---|---|---|---|
| L1 | queued 最终到达 pending 或 deleted | $s = \text{queued} \leadsto s \in \{ \text{pending}, \text{completed}, \text{deleted} \}$ | ✓ |
| L2 | pending 最终到达 in_progress 或 completed 或 deleted | $s = \text{pending} \leadsto s \in \{ \text{in\\\_progress}, \text{completed}, \text{deleted} \}$ | ✓ |
| L3 | in_progress 最终到达 completed 或 deleted | $s = \text{in\\\_progress} \leadsto s \in \{ \text{completed}, \text{deleted} \}$ | ✓ — 上限由 job timeout 约束（默认 360 min, max 35 days） |
| L4 | completed 可被 rerun 或 delete | $s = \text{completed} \implies$ 用户可触发 $\text{Rerun}$ 或 $\text{Delete}$ | ✓ |
| L5 | deleted 之后不可查询 | $s = \text{deleted} \implies \text{GetRun}(r) = 404$ | ✓ |

### 可达性 (Reachability)

| # | 属性 | 公式 | 验证 |
|---|---|---|---|
| R1 | 新建 run 可到达 completed | $\exists \omega^*: \delta^*(\varnothing, \omega^*) = \text{completed}$ | ✓ |
| R2 | completed 可被 rerun | $\delta(\text{completed}, \text{Rerun}) = \text{queued}$ | ✓ |
| R3 | completed 可被删除 | $\delta(\text{completed}, \text{Delete}) = \text{deleted}$ | ✓ |
| R4 | 运行中 run 可被取消 | $\delta(\text{in\\\_progress}, \text{Cancel}) = \text{completed}$ ($\text{conc}=\text{cancelled}$) | ✓ |
| R5 | deleted 不可复活 | $R^*(\text{deleted}) = \{ \text{deleted} \}$ | ✓ |
| R6 | completed 可通过 rerun 重新到达 in_progress | $\delta^*(\text{completed}, [\text{Rerun}, \text{dequeue}, \text{assign}]) = \text{in\\\_progress}$ | ✓ |

---

## GitHub × ECI 真值表对比

| 维度 | ECI ContainerGroup | GitHub Actions WorkflowRun |
|---|---|---|
| 硬终态数量 | 5 | 1 (deleted) |
| 软终态 | 无 | 1 (completed) |
| 终态 → 活跃 | 不可 | 可（RerunRun / RerunFailedJobs） |
| 取消语义 | 无；Delete 直接走 Terminating | Cancel → completed(cancelled)，数据保留 |
| 删除语义 | Delete → Terminating → Deleted（异步） | Delete → deleted（同步 204） |
| 子资源结论聚合 | 无显式 conclusion | 有（Job → Step 向上聚合） |
| 幂等保证 | ClientToken | Cancel/Delete 效果幂等，Create 不幂等 |
