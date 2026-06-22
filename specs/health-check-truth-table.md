# 健康检查真值表

## 输入变量

| 变量 | 含义 | 值域 |
|------|------|------|
| `S` | sandbox.status | `Deleted` / `Stopped` / `Running` / `Other` |
| `T` | stoppedDuration > 60s | `Y` / `N` |
| `M` | maxRetries | `-1` / `>=0` |
| `R` | getStatus() runtime | `null` / `object` |
| `A` | anyRunning | `true` / `false` |
| `H` | allHealthy | `true` / `false` |
| `F` | fails >= maxRetries | `Y` / `N` |

注：`A` 和 `H` 仅在 `R=object` 时有意义。`F` 仅在 `H=false` 时评估。

## 真值表

| # | S | T | M | R | A | H | F | 动作 | 原因 |
|---|----|----|----|----|----|----|----|------|------|
| 1 | Deleted | — | — | — | — | — | — | skip | 已删除 |
| 2 | Stopped | N | — | — | — | — | — | skip | 停止未超 60s |
| 3 | Stopped | Y | — | — | — | — | — | provider.delete + set Deleted | **stopped-gc** |
| 4 | Running | — | -1 | — | — | — | — | skip | 白名单 |
| 5 | Running | — | >=0 | null | — | — | — | set Deleted | **provider-gone** |
| 6 | Running | — | >=0 | object | false | — | — | provider.delete + set Deleted | **exited-gc** |
| 7 | Running | — | >=0 | object | true | true | — | fail=0 (reset) | 健康 → 重置计数器 |
| 8 | Running | — | >=0 | object | true | false | N | fail++ | 不健康 → 计数 |
| 9 | Running | — | >=0 | object | true | false | Y | provider.delete + set Deleted | **unhealthy-gc** |
| 10 | Other (Pending/Scheduling/Failed/Terminated) | — | — | — | — | — | — | skip（已修复） | 非 Running 不执行健康检查 |

## 决策树

```
entry.value.status
├─ Deleted → skip
├─ Stopped
│  ├─ stoppedDuration > 60s → delete container + sandbox [stopped-gc]
│  └─ ≤ 60s → skip
├─ Other (Pending/Scheduling/Failed/Terminated)
│  └─ 穿透到 Running 路径（⚠️ 潜在 bug: 非 Running 状态不应执行健康检查）
└─ Running
   ├─ maxRetries === -1 → skip（白名单）
   └─ maxRetries >= 0
      ├─ getStatus() → null → set Deleted [provider-gon]
      ├─ getStatus() → runtime
      │  ├─ no containers alive (anyRunning=false) → delete + set Deleted [exited-gc]
      │  └─ some running (anyRunning=true)
      │     ├─ all healthy → reset fail=0
      │     └─ not all healthy
      │        ├─ fail < maxRetries → fail++
      │        └─ fail >= maxRetries → delete + set Deleted [unhealthy-gc]
```

## 路径覆盖率

| 路径 | 行号 | 测试用例 |
|------|------|---------|
| 1 — Deleted skip | 141 | sandbox.status=Deleted |
| 2 — Stopped < 60s | 143-162 | sandbox Stopped, recent |
| 3 — Stopped >= 60s | 145-161 | sandbox Stopped, old → verify provider.delete + status=Deleted |
| 4 — maxRetries=-1 | 165 | Running sandbox with healthMaxRetries=-1 |
| 5 — provider-gone | 167-180 | getStatus returns null |
| 6 — exited-gc | 187-200 | anyRunning=false |
| 7 — healthy reset | 203-205 | allHealthy=true |
| 8 — unhealthy count | 207-209 | allHealthy=false, fail < maxRetries |
| 9 — unhealthy-gc | 210-220 | allHealthy=false, fail >= maxRetries |
| 10 — Other (bug) | 164+ | status=Pending/Scheduling/Failed/Terminated leak through |
