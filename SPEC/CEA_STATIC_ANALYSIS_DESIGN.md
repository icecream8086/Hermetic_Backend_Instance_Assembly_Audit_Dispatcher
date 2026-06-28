# CEA 静态分析设计 — 控制流图 & 数据流追踪

## 当前状态

ESLint `no-restricted-syntax` 已在 AST 层面封死 12 类语法逃逸：

```
解码层:    safeParse, .catch().parse()
错误层:    catch{return}, catch(e){return literal}, .catch()
断言层:    return as T, typeof?:fallback
污染层:    Object.assign(), Boolean(), !!
裸解析:    Array.isArray(), 裸JSON.parse()
```

加上类型级封杀（`any`, `as`, `!`, `Partial`, `Pick`, `Omit`, `Function`, `Object`, `{}`）和逃逸通道锁（`no-restricted-disable` 等），共 23 条规则。

## 剩余盲区

ESLint 只做单文件 AST 检查，以下模式无法被 AST selector 精准命中：

| 盲区 | 原因 | 需要的能力 |
|---|---|---|
| `unknown` 泄漏到非 decoder 层 | 跨文件类型传播 | TypeChecker / CFG |
| Helper 函数包装吞错 | 过程间调用图 | Call Graph |
| `instanceof` 守卫 vs 合法 error 判断 | 上下文语义 | TypeChecker + 启发式 |
| `if(typeof x === 'string')` 人肉解析 | 行内守卫无 Zod | TypeChecker |
| 双重变量赋值污染 | 数据流分析 | DFG / Taint |

---

## 方案一：TypeChecker API（推荐入门）

### 架构

```
ESLint Rule
  ├── AST 遍历 (单文件, ESLint 提供)
  └── TypeChecker (全项目类型图, tsc 提供)
        ├── checker.getTypeAtLocation(node)     — 查询任意 AST 节点的推断类型
        ├── checker.getSymbolAtLocation(node)   — 查询符号的定义位置
        ├── checker.getDeclaredTypeOfSymbol(s)  — 查询声明的完整类型
        └── program.getSourceFiles()            — 遍历所有源文件
```

TypeChecker 构建了**全项目类型解析图**——它能告诉你任意表达式的类型、该类型的 `flags`（是否含 `unknown`/`any`/`never`）、以及符号来自哪个文件。

### 可实现规则

#### 规则 1: `no-unknown-leak` — 禁止 `unknown` 离开解码层

```typescript
// 伪代码
export const rule = ESLintUtils.RuleCreator(docs => docs)({
  name: 'no-unknown-leak',
  meta: { type: 'problem', docs: { description: 'unknown 类型只允许存在于 decoder/ 目录' } },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    const filename = context.filename;

    // 豁免：decoder 层 / 测试文件 / 类型定义文件
    if (filename.includes('/decoder/') || filename.includes('.test.') || filename.endsWith('.d.ts')) {
      return {};
    }

    return {
      // 检查函数返回类型是否包含 unknown
      FunctionDeclaration(node) {
        if (!node.returnType) return; // 没有显式返回类型注解，放过
        const tsNode = services.esTreeNodeToTSNodeMap.get(node.returnType);
        const type = checker.getTypeFromTypeNode(tsNode);
        if (containsUnknown(type)) {
          context.report({ node, messageId: 'unknownInReturn' });
        }
      },
      // 检查变量声明
      VariableDeclarator(node) {
        if (!node.id.typeAnnotation) return;
        const tsNode = services.esTreeNodeToTSNodeMap.get(node.id.typeAnnotation);
        const type = checker.getTypeFromTypeNode(tsNode);
        if (containsUnknown(type)) {
          context.report({ node, messageId: 'unknownInVar' });
        }
      },
    };
  },
});

function containsUnknown(type: ts.Type): boolean {
  if (type.flags & ts.TypeFlags.Unknown) return true;
  if (type.isUnion()) return type.types.some(t => containsUnknown(t));
  return false;
}
```

#### 规则 2: `no-handwritten-guard` — 禁止手写类型守卫

检测 `typeof x === 'string'` / `'id' in obj` / `instanceof` 用于类型收窄的模式（排除 error 处理）：

```typescript
// 匹配 if(typeof x === 'string') { ... } 用于类型收窄
IfStatement(node) {
  const test = node.test;
  // 检查是否为 typeof / instanceof / in 表达式
  if (test.type === 'BinaryExpression' &&
      (test.operator === 'instanceof' || test.left.type === 'UnaryExpression')) {
    // 排除 instanceof AppError / Error 的合法使用
    if (test.operator === 'instanceof') {
      const rightType = checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(test.right));
      if (rightType.symbol?.name === 'AppError' || rightType.symbol?.name === 'Error') return;
    }
    context.report({ node, messageId: 'handwrittenGuard' });
  }
}
```

#### 规则 3: `enforce-decode-layer` — 强制统一解码入口

要求所有外部数据解析（`JSON.parse` / `fetch().json()` / `c.req.json()`）必须经过 `decode(schema, raw)` 或 `schema.parse(raw)`：

```typescript
CallExpression(node) {
  // 匹配 c.req.json() 但不匹配 schema.parse(c.req.json())
  if (isRawJsonCall(node) && !isWrappedByParse(node)) {
    context.report({ node, messageId: 'rawParse' });
  }
}
```

### 成本估算

| 规则 | 行数 | 复杂度 |
|---|---|---|
| `no-unknown-leak` | ~120 | 中 — 需要理解 TypeChecker API |
| `no-handwritten-guard` | ~100 | 中 — 需要区分守卫 vs 合法分支 |
| `enforce-decode-layer` | ~80 | 低 |
| 合计 | ~300 | 约 2-3 个工作日 |

### 项目结构

```
src/
├── eslint-rules/              ← 新建
│   ├── index.ts               ← barrel export
│   ├── no-unknown-leak.ts
│   ├── no-handwritten-guard.ts
│   └── enforce-decode-layer.ts
└── eslint.config.mjs          ← 引入自定义规则
```

在 `eslint.config.mjs` 中注册：

```javascript
import { noUnknownLeak } from './src/eslint-rules/no-unknown-leak.ts';
// ...
{
  plugins: {
    'cea': { rules: { 'no-unknown-leak': noUnknownLeak } },
  },
  rules: {
    'cea/no-unknown-leak': 'error',
  },
}
```

---

## 方案二：Semgrep（中门槛）

### 适用场景

Semgrep 的 **taint mode** 能做简单的过程间数据流追踪——从 source（如 `JSON.parse`）到 sink（如 `return`）之间是否有 sanitizer（如 `schema.parse`）。

### 示例规则：JSON.parse 未消毒

```yaml
rules:
  - id: json-parse-without-zod-sanitizer
    mode: taint
    pattern-sources:
      - pattern: JSON.parse(...)
    pattern-sinks:
      - pattern: return $X
    pattern-sanitizers:
      - pattern: $SCHEMA.parse(...)
    message: JSON.parse() 的返回值在返回前未经过 Zod schema.parse() 消毒
    severity: ERROR
```

### 限制

- Taint mode 是过程内的——跨函数调用需要 `pattern-propagators`
- 不支持 TypeScript 类型信息——只能做字符串级别的模式匹配
- 无法区分 `unknown` 和 `string` 的类型传播

### 集成方式

```bash
# CI 中独立运行
semgrep --config spec/semgrep-rules/ src/
```

---

## 方案三：CodeQL（高门槛，终极方案）

### 适用场景

CodeQL 构建完整的过程间控制流图 (CFG) 和数据流图 (DFG)，支持：
- 跨函数调用追踪
- 类型感知的污点分析
- 自定义 QL 查询语言

### 示例查询：追踪 unknown 类型传播

```ql
import typescript

from FunctionExpr f, ReturnStmt r, Expr e
where
  r.getEnclosingFunction() = f and
  e = r.getExpr() and
  e.getType().containsUnknown() and
  not f.getFile().getRelativePath().matches("src/decoder/%")
select r, "unknown 类型通过 return 逃离解码层"
```

### 集成方式

需要 GitHub Advanced Security 或独立运行 CodeQL CLI：

```bash
codeql database create ./db --language=typescript
codeql database analyze ./db spec/codeql-queries/cea.ql --format=sarif --output=cea-results.sarif
```

### 成本

- 学习 QL 查询语言（声明式、类 Datalog）
- 构建数据库 (cold start ~2min)
- CI 集成需要 GitHub Actions + SARIF upload

---

## 分阶段实施路线

| 阶段 | 工具 | 规则 | 投资 |
|---|---|---|---|
| **Phase 1 (当前)** | ESLint AST | 23 条 `no-restricted-syntax` | ✅ 完成 |
| **Phase 2 (近期)** | ESLint TypeChecker | `no-unknown-leak` + `no-handwritten-guard` + `enforce-decode-layer` | ~3 天 |
| **Phase 3 (中期)** | Semgrep taint | JSON.parse → return 未消毒检测 | ~1 天 |
| **Phase 4 (远期)** | CodeQL | 全项目 CFG + DFG 类型污染检测 | ~1 周 |

---

## 控制流图概念速查

```
AST          — 抽象语法树（单文件、无类型信息）
TypeChecker  — 类型解析图（全项目、跨文件类型查询）
CFG         — 控制流图（基本块 + 跳转边）
DFG         — 数据流图（值从定义点到使用点的传播路径）
Call Graph  — 调用图（函数间的调用关系）
Taint       — 污点分析（未消毒数据从 source 到 sink 的路径）
```

```
ESLint 能力边界:
  AST + TypeChecker .......................... ████████████░░░░
  CFG ........................................ ░░░░░░░░░░░░░░░░
  DFG ........................................ ░░░░░░░░░░░░░░░░
  Call Graph ................................. ░░░░░░░░░░░░░░░░

Semgrep 能力边界:
  AST + Taint (过程内) ....................... ████████░░░░░░░░
  Taint (过程间, 需显式 propagator) ........... ██░░░░░░░░░░░░░░
  类型感知 .................................... ░░░░░░░░░░░░░░░░

CodeQL 能力边界:
  AST + TypeChecker .......................... ████████████████░
  CFG ........................................ ████████████████░
  DFG ........................................ ████████████████░
  Call Graph ................................. ████████████████░
```
