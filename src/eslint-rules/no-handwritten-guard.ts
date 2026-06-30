import type { TSESLint, TSESTree } from '@typescript-eslint/utils';

type MessageIds = 'typeofGuard' | 'instanceofGuard' | 'inGuard';

/**
 * Ban handwritten type guards using `typeof` / `instanceof` / `in`.
 *
 * These patterns bypass the Zod schema parsing layer and create
 * unsound type narrowing. The exception is `instanceof` for
 * Error subclasses (AppError, TypeError, etc.).
 */
const rule: TSESLint.RuleModule<MessageIds> = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow handwritten type guards (typeof, instanceof, in) in favor of Zod',
    },
    schema: [],
    messages: {
      typeofGuard:
        'Handwritten typeof type guard detected. Use Zod schema.parse() instead.',
      instanceofGuard:
        'Handwritten instanceof type guard detected. Use Zod schema.parse() instead (Error subclasses excluded).',
      inGuard:
        'Handwritten "in" type guard detected. Use Zod schema.parse() instead.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      'BinaryExpression[operator="==="] > UnaryExpression[operator="typeof"]'(
        node: TSESTree.Node,
      ) {
        context.report({ node, messageId: 'typeofGuard' });
      },
      'BinaryExpression[operator="!=="] > UnaryExpression[operator="typeof"]'(
        node: TSESTree.Node,
      ) {
        context.report({ node, messageId: 'typeofGuard' });
      },
      'BinaryExpression[operator="instanceof"]'(
        node: TSESTree.Node & { right?: TSESTree.Node & { name?: string } },
      ) {
        if (node.right?.type === 'Identifier') {
          const name = node.right.name;
          if (
            name === 'Error' ||
            name.endsWith('Error') ||
            name === 'TypeError' ||
            name === 'RangeError' ||
            name === 'SyntaxError' ||
            name === 'ReferenceError'
          ) {
            return;
          }
        }
        context.report({ node, messageId: 'instanceofGuard' });
      },
      'BinaryExpression[operator="in"]'(
        node: TSESTree.Node,
      ) {
        context.report({ node, messageId: 'inGuard' });
      },
    };
  },
};

export default rule;
