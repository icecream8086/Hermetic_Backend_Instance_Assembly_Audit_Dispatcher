import type { TSESLint, TSESTree } from '@typescript-eslint/utils';

type MessageIds = 'emptyOpenapi';

const ALLOWED_NAMES = new Set(['EmptyResponse']);

/**
 * Ban empty z.object({}) in .openapi() chains.
 * Only triggers in response-schema.ts files.
 */
const rule: TSESLint.RuleModule<MessageIds> = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow z.object({}) in .openapi() chain calls — use a proper Zod schema',
    },
    schema: [],
    messages: {
      emptyOpenapi: 'Empty z.object({}) in .openapi() chain. Use a proper Zod schema (e.g., PodSpecSchema).',
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = context.filename;
    if (!filename.endsWith('/response-schema.ts')) return {};

    return {
      'CallExpression[callee.property.name="openapi"]'(
        node: TSESTree.CallExpression,
      ) {
        const obj = (node.callee as TSESTree.MemberExpression | undefined)
          ?.object;
        if (obj?.type !== 'CallExpression') return;
        const callee = obj.callee as TSESTree.MemberExpression | undefined;
        if (callee?.property?.type !== 'Identifier') return;
        if (callee.property.name !== 'object') return;

        const arg = obj.arguments[0];
        if (arg?.type !== 'ObjectExpression') return;
        if (arg.properties.length > 0) return;

        const name = node.arguments[0] as TSESTree.Literal | undefined;
        if (name?.type === 'Literal' && typeof name.value === 'string' && ALLOWED_NAMES.has(name.value)) return;

        context.report({ node, messageId: 'emptyOpenapi' });
      },
    };
  },
};

export default rule;
