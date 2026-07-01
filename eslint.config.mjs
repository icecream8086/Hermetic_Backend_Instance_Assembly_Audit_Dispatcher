import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments';
import ts from 'typescript';

// ═══════════════════════════════════════════════════════════════
// CEA Phase 2 — TypeChecker 自定义规则
// ═══════════════════════════════════════════════════════════════

/** no-unknown-leak: 禁止 unknown 类型离开 decoder/provider 层 */
const noUnknownLeak = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow unknown types from leaking outside decoder/provider layers', requiresTypeChecking: true },
    schema: [],
    messages: { unknownLeak: 'Unknown type is leaking from this function. Decoder/provider layers must resolve unknown via Zod schema.parse() before returning.' },
  },
  create(context) {
    const filename = context.filename;
    const isDecoderOrProvider = filename.includes('/decode/') || filename.includes('/providers/');
    if (isDecoderOrProvider) return {};

    const parserServices = context.sourceCode?.parserServices;
    if (!parserServices?.program) return {};
    const checker = parserServices.program.getTypeChecker();

    function containsUnknown(type) {
      if (type.flags & ts.TypeFlags.Unknown) return true;
      if (type.isUnion()) return type.types.some((t) => containsUnknown(t));
      return false;
    }

    function checkReturnType(node) {
      try {
        const tsNode = parserServices.esTreeNodeToTSNodeMap.get(node);
        if (!tsNode) return;
        if (!ts.isFunctionLike(tsNode)) return;
        const signature = checker.getSignatureFromDeclaration(tsNode);
        if (!signature) return;
        const returnType = checker.getReturnTypeOfSignature(signature);
        if (containsUnknown(returnType)) {
          context.report({ node, messageId: 'unknownLeak' });
        }
      } catch (e) {
        console.error('[local-rules/no-unknown-leak]', e instanceof Error ? e.message : String(e));
      }
    }
    return { 'FunctionDeclaration, FunctionExpression, ArrowFunctionExpression': checkReturnType };
  },
};

/** no-handwritten-guard: 禁止 typeof/instanceof/in 手写类型守卫（排除 Error 子类） */
const noHandwrittenGuard = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow handwritten type guards in favor of Zod', recommended: 'strict' },
    schema: [],
    messages: {
      typeofGuard: 'Handwritten typeof type guard detected. Use Zod schema.parse() instead.',
      instanceofGuard: 'Handwritten instanceof type guard detected (Error subclasses excluded). Use Zod schema.parse() instead.',
      inGuard: 'Handwritten "in" type guard detected. Use Zod schema.parse() instead.',
    },
  },
  create(context) {
    const errorLikeNames = new Set([
      'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError',
      'AppError', 'ZodError', 'TransactConflictError', 'AggregateError', 'BodyDepthError',
    ]);
    function isErrorSubclass(node) {
      if (node.right?.type === 'Identifier' && errorLikeNames.has(node.right.name)) return true;
      return false;
    }
    return {
      'IfStatement > BinaryExpression[operator="==="] > UnaryExpression[operator="typeof"]'(node) {
        context.report({ node, messageId: 'typeofGuard' });
      },
      'IfStatement > BinaryExpression[operator="!=="] > UnaryExpression[operator="typeof"]'(node) {
        context.report({ node, messageId: 'typeofGuard' });
      },
      'ConditionalExpression > BinaryExpression[operator="==="] > UnaryExpression[operator="typeof"]'(node) {
        context.report({ node, messageId: 'typeofGuard' });
      },
      'ConditionalExpression > BinaryExpression[operator="!=="] > UnaryExpression[operator="typeof"]'(node) {
        context.report({ node, messageId: 'typeofGuard' });
      },
      'BinaryExpression[operator="instanceof"]'(node) {
        if (!isErrorSubclass(node)) context.report({ node, messageId: 'instanceofGuard' });
      },
      // Only flag 'key' in obj when used as a type guard (inside if/ternary condition)
      'IfStatement > BinaryExpression[operator="in"]'(node) {
        context.report({ node, messageId: 'inGuard' });
      },
      'ConditionalExpression > BinaryExpression[operator="in"]'(node) {
        context.report({ node, messageId: 'inGuard' });
      },
    };
  },
};

/** enforce-decode-layer: 强制 JSON.parse() / c.req.json() 经过 Zod schema.parse() */
const enforceDecodeLayer = {
  meta: {
    type: 'problem',
    docs: { description: 'Enforce JSON.parse() and c.req.json() go through Zod schema.parse()', recommended: 'strict' },
    schema: [],
    messages: {
      bareJsonParse: 'Bare JSON.parse() detected. Wrap in schema.parse(JSON.parse(str)).',
      bareReqJson: 'c.req.json() detected without Zod .parse(). Use schema.parse(await c.req.json()).',
    },
  },
  create(context) {
    if (context.filename.includes('/providers/')) return {};
    return {
      'CallExpression[callee.object.name="JSON"][callee.property.name="parse"]'(node) {
        const parent = node.parent;
        if (parent?.callee?.property?.name === 'parse') return; // wrapped in .parse()
        context.report({ node, messageId: 'bareJsonParse' });
      },
      'CallExpression[callee.property.name="json"]'(node) {
        const obj = node.callee?.object;
        if (!obj || obj.type !== 'MemberExpression' || obj.object?.name !== 'c' || obj.property?.name !== 'req') return;
        const parent = node.parent;
        if (parent?.callee?.property?.name === 'parse') return; // wrapped in .parse()
        context.report({ node, messageId: 'bareReqJson' });
      },
    };
  },
};

const localRules = { rules: { 'no-unknown-leak': noUnknownLeak, 'no-handwritten-guard': noHandwrittenGuard, 'enforce-decode-layer': enforceDecodeLayer } };

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@eslint-community/eslint-comments': eslintComments,
      'local-rules': localRules,
    },
    rules: {

      // ════════════════════════════════════════════════════════
      // CEA — 类型级封杀
      // ════════════════════════════════════════════════════════

      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-declaration-merging': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',

      '@typescript-eslint/consistent-type-assertions': [
        'error',
        {
          assertionStyle: 'never',
        },
      ],
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-expect-error': 'allow-with-description',
          minimumDescriptionLength: 10,
        },
      ],
      '@typescript-eslint/no-empty-function': [
        'error',
        {
          allow: [],
        },
      ],
      '@typescript-eslint/no-empty-interface': 'error',
      '@typescript-eslint/no-empty-object-type': 'error',
      '@typescript-eslint/no-restricted-types': [
        'error',
        {
          types: {
            Partial: '禁止使用 Partial 稀释核心业务契约。如有可选字段，请在类型中显式使用 ? 标记。',
            Omit: '禁止使用 Omit 剔除必填字段来偷懒。请明确定义新的接口。',
            Pick: '禁止使用 Pick 选取部分字段来绕过完整契约校验。',
            Function: '禁止使用 Function 类型，请使用具体函数签名 (args) => ReturnType。',
            Object: '禁止使用 Object 类型，请使用 Record<string, unknown> 或 object。',
            '{}': '禁止使用空对象类型 {}，请使用 Record<string, unknown>。',
          },
        },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        {
          requireDefaultForNonUnion: true,
        },
      ],
      'no-fallthrough': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          disallowTypeAnnotations: true,
          fixStyle: 'separate-type-imports',
        },
      ],
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-use-before-define': [
        'error',
        {
          functions: false,
        },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
          allowHigherOrderFunctions: true,
          allowDirectConstAssertionInArrowFunctions: true,
          allowConciseArrowFunctionExpressionsStartingWithVoid: true,
        },
      ],
      '@typescript-eslint/explicit-member-accessibility': [
        'error',
        {
          accessibility: 'explicit',
        },
      ],
      '@typescript-eslint/consistent-indexed-object-style': ['error', 'record'],
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],

      // ════════════════════════════════════════════════════════
      // CEA — 逻辑级猎杀（no-restricted-syntax × 7）
      // ════════════════════════════════════════════════════════

      'no-restricted-syntax': [
        'error',

        // ── 解码层 ──

        {
          // 1. 禁止 .safeParse() — 必须用 .parse() 让 ZodError 抛出
          selector: 'MemberExpression[property.name="safeParse"]',
          message:
            '禁止使用 .safeParse()。请用 .parse() 替代 — ZodError 会由全局错误处理器捕获并返回 400。' +
            '这是 CEA（编译期穷举完备性）在数据解码层的要求。',
        },
        {
          // 2. 禁止 Zod .catch(fallback).parse() — 静默吞掉解析失败返回默认值
          selector: 'CallExpression[callee.property.name="parse"] CallExpression[callee.property.name="catch"]',
          message:
            '禁止使用 .catch(default).parse() 静默吞错。' +
            '请直接用 .parse() — 解析失败应抛出 ZodError 由全局错误处理器接住。',
        },

        // ── 错误处理层 ──

        {
          // 3. 禁止 catch { return } — 无形参 catch 直接返回
          selector: 'CatchClause[param=null] ReturnStatement',
          message:
            '禁止在无错误参数的 catch 块中静默返回。' +
            '请用 catch (e) 显式捕获错误对象并明确处理（重新抛出 / 返回错误响应）。',
        },
        {
          // 4. 禁止 catch (e) { return 字面量 } — 有参数但返回了硬编码值
          selector: 'CatchClause > BlockStatement > ReturnStatement[argument.type!="Identifier"][argument.type!="CallExpression"]',
          message:
            '禁止在 catch 块中直接返回字面量或对象。' +
            '如需处理错误，请重新抛出或调用返回明确错误结构的函数。',
        },
        {
          // 5. 禁止所有 .catch() — Promise/Zod 静默吞错的最终形态
          selector: 'MemberExpression[property.name="catch"]',
          message:
            '禁止使用 .catch() 静默吞错（无论是 Promise.catch 还是 Zod.catch）。' +
            '请使用 try/catch 并显式重新抛出或返回错误响应。',
        },

        // ── 断言逃逸层 ──

        {
          // 6. 禁止 return val as T — 在出口处用断言污染调用方
          selector: 'ReturnStatement TSAsExpression',
          message:
            '禁止在 return 语句中使用类型断言。请重构调用链消除断言，或使用 Zod 校验。',
        },
        {
          // 7. 禁止 typeof v === 'string' ? v : fallback — 手写假守卫
          //    只匹配三目表达式中包含 typeof 比较的模式
          selector: 'ConditionalExpression[test.type="BinaryExpression"][test.left.type="UnaryExpression"][test.left.operator="typeof"]',
          message:
            '禁止手写 typeof 类型守卫三目表达式。这是假守卫——请使用 Zod schema.parse() 替代。',
        },

        // ── 类型污染层 ──

        {
          // 8. 禁止 Object.assign() — 类型污染，用展开语法 { ...a, ...b } 替代
          selector: 'CallExpression[callee.property.name="assign"][callee.object.name="Object"]',
          message:
            '禁止使用 Object.assign() 造成类型污染。请使用对象展开语法 { ...a, ...b } 替代。',
        },
        {
          // 9. 禁止 Boolean() 强制类型转换 — 隐藏 null/undefined
          selector: 'CallExpression[callee.name="Boolean"]',
          message:
            '禁止使用 Boolean() 强制类型转换。此操作会将 null/undefined 转为 false，隐藏真实类型。',
        },
        {
          // 10. 禁止 !! 双重否定 — 用显式比较取代隐式强制转换
          selector: 'UnaryExpression[operator="!"][argument.operator="!"]',
          message:
            '禁止使用 !! 双重否定强制类型转换。请用显式比较 (val !== null && val !== undefined) 取代。',
        },

        // ── 裸解析层 ──

        {
          // 11. 禁止 Array.isArray() — 手写数组类型守卫
          selector: 'CallExpression[callee.property.name="isArray"][callee.object.name="Array"]',
          message:
            '禁止使用 Array.isArray() 手写类型守卫。请使用 Zod schema.parse() 统一解码。',
        },
        {
          // 12. 禁止裸 JSON.parse() — 必须包裹在 Zod schema.parse() 中
          selector: 'CallExpression[callee.property.name="parse"][callee.object.name="JSON"]',
          message:
            '禁止裸 JSON.parse()。请用 schema.parse(JSON.parse(str)) 或 decode(schema, json) 统一入口，确保解析结果经过 Zod 校验。',
        },
        {
          // 13. 禁止 z.any() — Zod 运行时 any 逃逸，等同于 TypeScript any
          selector: 'CallExpression[callee.property.name="any"][callee.object.name="z"]',
          message:
            '禁止使用 z.any() 逃逸 Zod 类型校验。这是运行时等价于 TypeScript any 的逃逸舱口。' +
            '对于 OpenAPI 响应体，请用 z.object({...}) 描述完整响应结构；' +
            '对于不可预测的负载，请用 z.unknown() 替代——它至少强制消费端做类型收窄。',
        },
        {
          // 14. 禁止空 catch 块 — 静默吞错
          selector: 'CatchClause > BlockStatement[body.length=0]',
          message:
            '禁止空 catch 块静默吞错。请至少记录错误（console.error/audit.write）或重新抛出。',
        },
      ],

      // ════════════════════════════════════════════════════════
      // CEA Phase 2 — TypeChecker 规则（自定义）
      // ════════════════════════════════════════════════════════

      'local-rules/no-unknown-leak': 'error',
      'local-rules/no-handwritten-guard': 'error',
      'local-rules/enforce-decode-layer': 'error',

      // ════════════════════════════════════════════════════════
      // CEA — 锁死 ESLint 逃逸通道
      // ════════════════════════════════════════════════════════

      '@eslint-community/eslint-comments/no-unlimited-disable': 'error',

      '@eslint-community/eslint-comments/no-restricted-disable': [
        'error',
        '@typescript-eslint/consistent-type-assertions',
        '@typescript-eslint/no-explicit-any',
        '@typescript-eslint/no-non-null-assertion',
        'no-restricted-syntax',
      ],

      '@eslint-community/eslint-comments/require-description': [
        'error',
        {
          ignore: [],
        },
      ],
    },
  },
  // ═══════════════════════════════════════════════════════════════
  // 平台边界降级 — store 适配器 / Provider / Queue / 中间件
  //
  // 这些目录的代码与未类型化平台 API 交互（KV/DO/R2、阿里 ECI、
  // Podman REST、Cloudflare Workers），类型阻抗不匹配是架构性的。
  // 规则降级为 warn：保持可见（防止新增违规被静默忽略），
  // 但不阻塞 CI（已知违规不应阻止合并）。
  // ═══════════════════════════════════════════════════════════════
  {
    files: [
      'src/core/store/adapters/**/*.ts',
      'src/providers/**/*.ts',
      'src/queue/**/*.ts',
      'src/core/middleware/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-assertions': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      'no-restricted-syntax': 'warn',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', '*.js', '*.cjs', '*.mjs', '.data-test/**', '.data/**'],
  },
);
