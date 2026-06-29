# 重构路线图 v4

> 基线：ESLint 3289 errors，TODO.md Section 4 (PodmanPodCodec) 未完成  
> 原则：架构 > 根因类型 > 语义规则 > 机械清扫

---

## Phase 1：架构完整性

### 1.1 PodmanPodCodec（TODO.md Section 4）

**理由**：唯一的功能缺口。Alibaba 有 `AlibabaPodCodec implements PodCodec<T>`，Podman 没有。PodService 统一生命周期对 Podman 不可用，Actions × Pod 统一入口对 Podman 断裂。

输入：
- `core/pod/codec.ts` — PodCodec<T> 接口（encode / decode / decodeStatus）
- `providers/alibaba/pod-codec.ts` — 参考实现
- `providers/podman/podman-group-provider.ts` — 当前 Provider（旧 CreateContainerGroupInput）

产出：
- [ ] `providers/podman/pod-codec.ts` — PodmanPodCodec implements PodCodec<PodmanCreateRequest>
- [ ] `encode(PodSpec)` → Podman pod create JSON body（initContainers / terminationGracePeriod / dnsConfig）
- [ ] `decode(podman inspect JSON)` → PodRuntime
- [ ] `decodeStatus(raw)` → PodPhase
- [ ] `PodmanContainerGroupProvider.createPod()` 使用 PodmanPodCodec

### 1.2 消除 `@deprecated`（48 errors）

随 1.1 完成后自然消除。`CreateContainerGroupInput` 是唯一 `@deprecated` 源。

**Phase 1 目标：ESLint 3289 → 3241**

---

## Phase 2：根因类型修复

> `no-explicit-any`(492) + `consistent-type-assertions`(367) 是根因。  
> `no-unsafe-*`(1023) 是衍生错误——any 污染后所有成员访问变 unsafe。

### 2.1 `no-explicit-any` 热点歼灭（492 → ~150）

| P | 文件 | any | 方式 |
|---|------|-----|------|
| P0 | `providers/alibaba/cr-api.ts` | 118 | Zod schema 收窄 API 响应 |
| P1 | `core/store/adapters/durable-object.ts` | ~20 | 泛型约束 + Zod |
| P2 | `features/sandbox/sandbox.service.ts` | ~15 | PodService 委托严格类型 |
| P3 | 其余 79 文件 | ~339 | 逐个文件处理 |

### 2.2 `consistent-type-assertions` 热点歼灭（367 → ~200）

| P | 文件 | as | 方式 |
|---|------|-----|------|
| P0 | `features/sandbox/sandbox.service.ts` | 20 | Zod `.parse()` 收窄 |
| P1 | `core/events/health-check.ts` | 10 | Zod schema + 类型守卫 |
| P2 | `core/store/adapters/durable-object.ts` | 7 | 泛型约束 |
| P3 | 其余 93 文件 | ~330 | Zod 替代 `as` |

### 2.3 衍生清理

2.1 + 2.2 完成后 `no-unsafe-*` 预计从 1023 → ~400。剩余来自框架边界（Hono ctx / Cloudflare bindings），需适配层。

**Phase 2 目标：ESLint 3241 → ~1500**

---

## Phase 3：CEA 语义规则

> 保护 CEA 核心约束（禁止 typeof 守卫、裸 JSON.parse、Partial/Omit/Pick）。

### 3.1 `no-restricted-syntax`（312 errors, 100 files）

禁止模式：
- `typeof x === 'string'` → Zod schema 或 discriminated union
- 裸 `JSON.parse` → `const { parse } = JSON`

热点：
| 文件 | 数量 |
|------|------|
| `features/template/handler.ts` | 28 |
| `core/store/adapters/file-kv.ts` | 17 |
| `features/users/handler.ts` | 15 |
| `features/actions/handler.ts` | 10 |
| `core/store/adapters/file-query.ts` | 9 |
| `features/sandbox/sandbox.service.ts` | 9 |

### 3.2 `no-restricted-types`（33 errors, 21 files）

禁止 `Partial<T>` / `Omit<T, K>` / `Pick<T, K>`。展开为显式接口。

### 3.3 `no-non-null-assertion`（183 errors, 68 files）

`!` → `if` 守卫或 Zod parse。

**Phase 3 目标：ESLint ~1500 → ~800**

---

## Phase 4：机械规则清扫

| 规则 | 数量 | 文件 | 方式 |
|------|------|------|------|
| `restrict-template-expressions` | 201 | 59 | `${String(x)}` |
| `no-floating-promises` | 67 | 25 | `void` 标记 fire-and-forget |
| `no-empty-function` | 44 | 26 | 真实处理或 throw |
| `require-await` | 93 | 33 | 删 async 或加 await |
| `no-unnecessary-condition` | 180 | 56 | 删多余 `?.` / `??` |

放在最后——避免 Phase 2-3 重构后重复修。

**Phase 4 目标：ESLint ~800 → ~200**

---

## 预计曲线

```
Phase 1     Phase 2      Phase 3      Phase 4
 3289  →  3241  →  ~1500  →  ~800  →  ~200
         ↑          ↑          ↑         ↑
    PodmanCodec  any+as根因  CEA语义   机械清扫
```

## 完成定义

每阶段：涉及文件 `tsc --noEmit` 通过 + 目标规则归零。Phase N 完成前不跳跃到 Phase N+1。

## 更新记录

- 2026-06-29: 初版，基于 TODO2 核对结果生成
