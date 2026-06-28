# ESLint 修复计划

> 基线：4427 errors，0 warnings  
> 按难度分四档，从机械到架构逐档推进

---

## 一档：纯机械修复

### 1.1 explicit-member-accessibility（~202 errors）

给 class 成员加 `public` / `private` 修饰符。

| 文件 | 数量 |
|---|---|
| src/providers/alibaba/cr-api.ts | 119 |
| src/features/permission/service.ts | 54 |
| src/providers/alibaba/eci-api.ts | 37 |
| src/core/provider/factory.ts | 21 |
| src/core/auth/providers.ts | 20 |
| src/core/linked-list/list.ts | 20 |
| src/features/permission/group-manager.ts | 20 |
| src/features/users/service.ts | 20 |
| src/core/circular-queue/queue.ts | 18 |
| src/core/scheduler/dag/strategies.ts | 18 |
| src/features/sandbox/sandbox.service.ts | 18 |
| src/providers/podman/podman-provider.ts | 18 |
| src/providers/stub/container.ts | 16 |
| src/core/pod/service.ts | 14 |
| src/features/actions/extensions.ts | 14 |
| src/features/instances/service.ts | 14 |
| src/core/dag/graph.ts | 13 |
| src/core/event-bus/loop.ts | 13 |
| src/features/actions/scheduler-context.ts | 13 |
| src/features/ociruntime/oci-runtime.stub.ts | 13 |
| 其余 ~30 文件 | <10 each |

### 1.2 restrict-template-expressions（~159 errors）

`${number}` / `${any}` 在模板字符串中，加 `String()` 包裹。

### 1.3 no-floating-promises（~67 errors）

Promise 未被 await/void，加 `void` 前缀标记 fire-and-forget。

### 1.4 no-empty-function（~30 errors）

空箭头函数 / 空方法，填入 `{}` 或标记用途。

**一档合计：~458 errors**

---

## 二档：简单重构

### 2.1 no-non-null-assertion（~188 errors）

`!` 非空断言，用 `if` 守卫或 Zod 替代。

### 2.2 no-unnecessary-condition（~139 errors）

多余 `?.` 可选链 / `??` 空值合并，直接删掉。

**二档合计：~327 errors**

---

## 三档：类型系统重构（需要 Zod）

### 3.1 no-explicit-any（~492 errors）

加 Zod schema，用 `unknown` 收窄替代 `any`。

### 3.2 consistent-type-assertions（~372 errors）

`as` 断言，用 Zod `.parse()` 替代。brand type 已完成 6.2，剩余是业务代码 `as`。

### 3.3 no-unsafe-assignment / call / member-access / argument / return（~484 errors）

`any` 衍生问题，随 3.1 一起解决。

**三档合计：~1348 errors**

---

## 四档：架构依赖

### 4.1 no-deprecated（~29 errors）

`CreateContainerGroupInput` 已标记 `@deprecated`，需 Section 4 完成 PodmanPodCodec 后消除。

### 4.2 no-restricted-types（~25 errors）

`Partial` / `Omit` / `Pick` 禁用，需展开为显式接口。

**四档合计：~54 errors**

---

## 执行策略

```
一档 → 二档 → 三档 → 四档
(机械)  (重构)  (Zod)  (架构)
```

每次修一个文件，完成即停。每完成一批更新本 TODO。
