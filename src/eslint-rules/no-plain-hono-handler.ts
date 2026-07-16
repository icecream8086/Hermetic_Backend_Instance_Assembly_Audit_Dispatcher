import type { TSESLint, TSESTree } from '@typescript-eslint/utils';

type MessageIds = 'plainHono';

/**
 * Ban `new Hono()` in feature handler files.
 * Feature handlers must use `new OpenAPIHono()` so routes are
 * registered in the OpenAPI spec and visible in the SDK.
 */
const rule: TSESLint.RuleModule<MessageIds> = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Feature handler must use OpenAPIHono instead of plain Hono for OpenAPI registration',
    },
    schema: [],
    messages: {
      plainHono: 'Feature handler must use OpenAPIHono instead of plain Hono for OpenAPI registration.',
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = context.filename;
    if (!filename.includes('features') || !filename.endsWith('handler.ts')) return {};

    return {
      'NewExpression'(node: TSESTree.NewExpression) {
        if (node.callee.type !== 'Identifier') return;
        if (node.callee.name !== 'Hono') return;
        context.report({ node, messageId: 'plainHono' });
      },
    };
  },
};

export default rule;
