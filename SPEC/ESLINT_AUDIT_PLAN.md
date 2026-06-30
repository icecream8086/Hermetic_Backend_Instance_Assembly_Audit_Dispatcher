# ESLint 审计与改进计划

## Context

对 HBI-AAD 项目执行完整的 ESLint 审计 + 改进，按照"通用三步法"：形式化验证 → 静态分析/审计 → 架构决策/重构。

**现状**: `eslint.config.mjs` 已配置 23+ 条规则（10 类型级 + 13 AST selector），但 `src/` 仍有 **2070 个错误 + 4 个警告**。核心矛盾：规则设计完善，但代码库未达标。

---

## 解析方法

ESLint JSON 输出过大（5.3MB），直接管道处理会失败。采用两步法：

```bash
# 1. 将 JSON 输出写入文件（2>/dev/null 吞掉进度条）
npx eslint src/ --format json 2>/dev/null > eslint_src.json

# 2. Node 脚本从文件读取（避免 shell 转义和管道缓冲区）
node -e "
var d = JSON.parse(require('fs').readFileSync('eslint_src.json', 'utf8'));
var c = {};
d.forEach(function(f) {
  f.messages.forEach(function(m) {
    if (m.ruleId === 'no-restricted-syntax') {
      var k = m.message.slice(0, 60);
      c[k] = (c[k] || 0) + 1;
    }
  });
});
var s = Object.entries(c).sort(function(a,b) { return b[1] - a[1] });
s.forEach(function(e) { console.log(e[1] + '\t' + e[0]); });
"
```

**注意**:
- 必须用 `function` 而非 `=>`（箭头函数在 `-e` 的 `--eval` 模式下有语法歧义）
- 禁止在 `-e` 脚本中使用正则字面量（shell 转义会破坏反斜杠）
- `2>/dev/null` 必须先吞掉进度输出，否则 JSON 被污染
- 临时文件 `eslint_out.json`、`eslint_src.json`、`eslint_src_out.json` 已加入 `.gitignore`

---

## 第一步：形式化验证（已完成）

### CEA_STATIC_ANALYSIS_DESIGN.md 对照

| 阶段 | 设计规定 | 实际状态 | 差距 |
|------|---------|---------|------|
| Phase 1 (AST selector) | 23 条规则 | 23 条规则已配置 | 无差距 |
| Phase 2 (TypeChecker) | `no-unknown-leak`、`no-handwritten-guard`、`enforce-decode-layer` | **未实现** | **关键差距** |
| Phase 3 (Semgrep) | Taint mode | 未开始 | 按路线图可接受 |
| Phase 4 (CodeQL) | 全项目 CFG/DFG | 未开始 | 按路线图可接受 |

### 违规分布（`src/` 仅限）

```
 429  no-restricted-syntax
 301  consistent-type-assertions (as 断言)
 271  no-unsafe-member-access
 244  no-explicit-any
 195  no-unnecessary-condition
 183  no-unsafe-assignment
 175  no-non-null-assertion
 119  no-unsafe-argument
  72  no-unsafe-call
  17  no-unsafe-return
  10  no-restricted-disable (禁用锁定规则的 eslint-disable)
```

### no-restricted-syntax 细分

```
202  z.any() — OpenAPI 响应 schema 逃逸舱口
111  return val as T — 返回语句断言
 52  .catch() — Promise/Zod 静默吞错
 23  catch { return literal } — catch 返回字面量
 16  catch { return } — 无形参 catch 返回
 12  Array.isArray() — 手写守卫
  6  .safeParse() — Zod 安全解析
  4  typeof ?: fallback — 假守卫三目
  3  裸 JSON.parse()
```

### 最差文件 Top 10

```
163  src/features/actions/handler.ts       (主要是 z.any())
112  src/features/template/handler.ts
 88  src/features/topology/handler.ts
 69  src/features/users/handler.ts
 62  src/features/actions/job-operator.ts
 57  src/providers/podman/podman-provider.ts
 56  src/features/users/service.ts
 55  src/features/template/applicator.ts
 54  src/queue/consumer.ts
 50  src/features/actions/runner.ts
```

---

## 第二步：静态分析 + 审计（执行计划）

### A. 修复 z.any() — 最高影响（~202 违规）

**问题**: 每个 `createRoute()` 调用都用 `z.any()` 作为 OpenAPI 响应 schema。

**方案**: 创建 `src/core/http-docs/response-schema.ts` 提供通用响应包装器：

```typescript
export const OkResponse = <T extends z.ZodType>(schema: T) =>
  z.object({ success: z.literal(true), data: schema });

export const PaginatedResponse = <T extends z.ZodType>(item: T) =>
  z.object({
    success: z.literal(true),
    data: z.object({
      items: z.array(item),
      total: z.number(),
      page: z.number(),
      limit: z.number(),
    }),
  });
```

然后用 `OkResponse(z.unknown())` 替换所有 handler 中的 `z.any()`（过渡方案），后续再细化具体 schema。

**影响**: 消除 ~202 个 z.any() 违规，级联消除大部分 301 个类型断言错误。

### B. 实现 Phase 2 TypeChecker 规则（~300 行新代码）

创建 `src/eslint-rules/` 目录，含 3 条自定义规则：

1. **`no-unknown-leak`** (~120 行) — 禁止 `unknown` 类型离开 decoder/provider 层
2. **`no-handwritten-guard`** (~100 行) — 禁止 `typeof`/`instanceof`/`in` 手写类型守卫（排除 Error 子类）
3. **`enforce-decode-layer`** (~80 行) — 强制所有 `JSON.parse()`/`c.req.json()` 经过 Zod schema

在 `eslint.config.mjs` 中注册。

### C. 修复返回语句 as 断言（~111 违规）

在 Zod schema 定义中使用 `.transform()` 生成正确输出类型，替代 handler 中的 `as Type`。

### D. 修复 no-unnecessary-condition（~195 违规）

移除类型保证非空值的防御性可选链（~150 个可自动修复），保留合理的防御性检查（~45 个加 eslint-disable）。

### E. 修复 non-null 断言（~175 违规）

将 `.filter().map(e => e!.value)` 替换为显式循环 + 类型收窄。

### F. 审计 eslint-disable 注释（~130 处）

- 大部分合法（接口契约、存根实现、平台边界）
- 10 处 `no-restricted-disable` 违规需要文档记录
- file-level `/* eslint-disable */` 限制为仅存根文件

### G. 修复剩余 safeParse()（~6 违规）

在 `features/permission/handler.ts` 和 `features/users/handler.ts` 中替换为 `.parse()`。

### H. 新增 2 个 AST selector

1. **z.unknown() 范围限制** — 在非 decoder/provider 文件中禁止
2. **空 catch 块** — 禁止 `catch {}` 静默吞错

---

## 第三步：架构决策

### 决策表

| 事项 | 决策 | 理由 |
|------|------|------|
| z.any() → 什么？ | `z.unknown()` + 响应包装器 | 文档性与严格性的平衡 |
| Phase 2 TypeChecker 规则 | 现在实施 | 设计文档指定为"近期" |
| non-null 断言 | 分批修复 | 175 个违规，低风险 |
| Catch 块模式 | 按 case 评估 | 部分合法（fire-and-forget 清理） |
| store 适配器 as 断言 | 保留 + 文档 | 平台类型→领域类型的桥梁 |
| Provider any/unknown | 保留 + 文档 | 外部 API 阻抗不匹配 |

### 净变更估算

| 指标 | 修改前 | 修改后 | 变化 |
|------|--------|--------|------|
| ESLint 错误总数 | 2070 | ~300-400 | -1700 |
| z.any() | 202 | 0 | -202 |
| as 断言 | 301 | ~80 | -221 |
| unsafe-member-access | 271 | ~40 | -231 |
| explicit-any | 244 | ~30 | -214 |
| unnecessary-condition | 195 | ~45 | -150 |
| non-null-assertion | 175 | ~80 | -95 |
| TypeChecker 规则 | 0 条 | 3 条 | +3 |
| 新增文件 | - | 5 | +5 |
| ESLint 配置行数 | 254 | ~310 | +56 |
| eslint-disable 注释 | 130 | ~135 | +5 |

### 预计残留（~300-400）为架构必要性违规

- **store 适配器边界** (~50): KV/DO/FileKV 与未类型化平台 API 交互
- **Provider API 响应** (~80): 阿里 ECI/Podman/Cloudflare API 返回未类型化 JSON
- **Hono 框架类型** (~40): `c.req.param()` 和 `c.var` 类型限制
- **级联 unsafe-*** (~130): 以上三类的直接后果

---

## 实施顺序

```
阶段 1（基础设施）
  Day 1: 创建 src/core/http-docs/response-schema.ts（共享响应包装器）
  Day 2-3: 修复所有 handler 中的 z.any()（约 15 个文件，202 个违规）
  Day 4: 创建 src/eslint-rules/ → 实现 3 条 TypeChecker 规则
  Day 5: 添加 2 个新 AST selector + 审计 eslint-disable 文档

阶段 2（级联修复）
  Day 1-2: 修复返回 as 断言 + 类型断言（约 200 个违规）
  Day 3: 修复 no-unnecessary-condition（约 150 个可自动修复）
  Day 4-5: 运行全量 lint + 修复 TypeChecker 规则发现的新违规

阶段 3（残留）
  Day 1-2: 修复 top 10 文件中的 non-null 断言
  Day 3: 修复剩余 safeParse()
  Day 4: 最终审计 → 验证 ~300 残留 + 全量测试 + tsc --noEmit
```

---

## 关键修改文件

- `eslint.config.mjs` — 核心配置（+3 条规则 + 2 个 AST selector）
- `src/core/http-docs/response-schema.ts` — **新增**：共享响应 schema
- `src/eslint-rules/no-unknown-leak.ts` — **新增**：TypeChecker 规则
- `src/eslint-rules/no-handwritten-guard.ts` — **新增**：TypeChecker 规则
- `src/eslint-rules/enforce-decode-layer.ts` — **新增**：TypeChecker 规则
- `src/eslint-rules/index.ts` — **新增**：barrel export
- `src/features/actions/handler.ts` — 最差文件（163 违规）
- `src/features/template/handler.ts` — 第二差（112 违规）
- `src/features/topology/handler.ts` — 第三差（88 违规）
- `src/features/users/handler.ts` — safeParse 位于此处
- `src/features/permission/handler.ts` — safeParse 位于此处

## 验证

```bash
npx eslint src/ --format stylish    → 验证总错误数 ≤ 400
npx tsc --noEmit                    → 0 错误
npx vitest run                      → 全量通过
git diff --stat                     → 确认变更范围
```
