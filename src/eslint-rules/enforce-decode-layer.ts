import type { TSESLint, TSESTree } from '@typescript-eslint/utils';

type MessageIds = 'bareJsonParse' | 'bareReqJson';

/**
 * The parser attaches `.parent` to every AST node at runtime, but the
 * TSESTree type definitions do not include it.  This local interface lets
 * us access it via structural typing without a type assertion.
 */
interface AstNode {
  parent?: TSESTree.Node;
}

function parentIsParseCall(node: TSESTree.Node): boolean {
  return (
    node.parent?.type === 'CallExpression' &&
    node.parent.callee.type === 'MemberExpression' &&
    node.parent.callee.property.type === 'Identifier' &&
    node.parent.callee.property.name === 'parse'
  );
}

/** Walk up through AwaitExpression to find enclosing .parse() call. */
function isEnclosedByParseCall(node: TSESTree.Node): boolean {
  if (parentIsParseCall(node)) return true;
  if (node.parent?.type === 'AwaitExpression') {
    return isEnclosedByParseCall(node.parent);
  }
  return false;
}

/**
 * Enforce that all `JSON.parse()` / `c.req.json()` calls go through
 * a Zod schema `.parse()`.
 *
 * The check is structural (AST-based): we look for cases where these
 * call expressions appear as standalone values rather than as arguments
 * to `.parse()`.
 */
const rule: TSESLint.RuleModule<MessageIds> = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Enforce JSON.parse() and c.req.json() go through Zod schema.parse()',
    },
    schema: [],
    messages: {
      bareJsonParse:
        'Bare JSON.parse() detected. Wrap in schema.parse(JSON.parse(str)).',
      bareReqJson:
        'c.req.json() detected without Zod .parse(). Use schema.parse(await c.req.json()).',
    },
  },
  defaultOptions: [],
  create(context) {
    if (context.filename.includes('/providers/')) return {};

    return {
      'CallExpression[callee.object.name="JSON"][callee.property.name="parse"]'(
        node: TSESTree.CallExpression,
      ) {
        if (isEnclosedByParseCall(node)) return;
        context.report({ node, messageId: 'bareJsonParse' });
      },

      'CallExpression[callee.property.name="json"]'(
        node: TSESTree.CallExpression,
      ) {
        if (
          node.callee.type !== 'MemberExpression' ||
          node.callee.object.type !== 'MemberExpression'
        ) {
          return;
        }
        const obj = node.callee.object;
        if (
          obj.object.type === 'Identifier' &&
          obj.object.name === 'c' &&
          obj.property.type === 'Identifier' &&
          obj.property.name === 'req'
        ) {
          if (isEnclosedByParseCall(node)) return;
          context.report({ node, messageId: 'bareReqJson' });
        }
      },
    };
  },
};

export default rule;
