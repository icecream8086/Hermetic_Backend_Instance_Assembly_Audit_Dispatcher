import type { TSESLint, TSESTree } from '@typescript-eslint/utils';
import type { Program, TypeChecker } from 'typescript';

type MessageIds = 'unknownLeak';

/**
 * Ensure `unknown` types do not escape decoder/provider layers.
 *
 * Files inside `decode/` or `providers/` are allowed to propagate
 * `unknown` (they are the boundary). Any other file whose return
 * type resolves to `unknown` is flagged as a leak.
 */
const rule: TSESLint.RuleModule<MessageIds> = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow unknown types from leaking outside decoder/provider layers',
    },
    schema: [],
    messages: {
      unknownLeak:
        'Unknown type is leaking from this function. ' +
        'Decoder/provider layers must resolve unknown via Zod schema.parse() before returning.',
    },
  },
  defaultOptions: [],
  create(context) {
    const parserServices = (context as unknown as { services: { program: Program } | undefined }).services;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- ESLint rule injection boundary: parserServices may not exist at runtime
    if (!parserServices?.program) return {};
    const checker: TypeChecker = parserServices.program.getTypeChecker();

    const filename = context.filename;
    const isDecoderOrProvider =
      filename.includes('/decode/') || filename.includes('/providers/');

    if (isDecoderOrProvider) return {};

    function checkReturnType(node: TSESTree.Node) {
      try {
        const tsNode = checker.getResolvedSignature(
          (node as unknown as { tsNode: unknown }).tsNode as never,
        );
        if (!tsNode) return;
        const returnType = checker.getReturnTypeOfSignature(tsNode);
        if (returnType.flags & (1 << 25)) {
          // 1 << 25 = TypeFlags.Unknown
          context.report({ node, messageId: 'unknownLeak' });
        }
      } catch {
        // Type resolution failures are ignored
      }
    }

    return {
      'FunctionDeclaration, FunctionExpression, ArrowFunctionExpression'(
        node: TSESTree.Node,
      ) {
        checkReturnType(node);
      },
    };
  },
};

export default rule;
