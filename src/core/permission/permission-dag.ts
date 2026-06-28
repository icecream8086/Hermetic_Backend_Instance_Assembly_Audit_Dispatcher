import { Dag } from '../dag/graph.ts';
import { PermissionEffect } from './types.ts';
import type { PolicyId, PolicyNode, PermissionCheck, EvaluationResult } from './types.ts';

/**
 * Directed acyclic graph of permission policy nodes.
 *
 * Extends the generic `Dag` with domain-specific methods for building and
 * evaluating a permission policy graph. Evaluation uses **deny-overrides**:
 * if any matching policy has effect DENY, the result is immediately denied.
 * Otherwise the first matching ALLOW (in topological order) grants access.
 * If no policy matches, the result is denied by default.
 *
 * @example
 * ```ts
 * const dag = new PermissionDag();
 * dag.addPolicy({ id: p('admin'), effect: PermissionEffect.ALLOW, match: p => p.actor === 'root' });
 * dag.addPolicy({ id: p('deny-deleted'), effect: PermissionEffect.DENY, match: p => p.resourceId.startsWith('deleted-') });
 * dag.addDependency(p('deny-deleted'), p('admin'));  // deny-deleted evaluated first
 * ```
 */
export class PermissionDag extends Dag<PolicyId, PolicyNode> {
  public constructor() {
    super(node => node.id);
  }

  // ─── Building ───

  /** Register a policy node. Replaces any node with the same id. */
  addPolicy(node: PolicyNode): void {
    this.addNode(node);
  }

  /**
   * Add a dependency edge: `from` policy must be evaluated before `to`.
   * Both policy IDs must already exist.
   */
  addDependency(from: PolicyId, to: PolicyId): void {
    this.addEdge(from, to);
  }

  // ─── Evaluation ───

  /**
   * Evaluate all matching policies in topological order.
   *
   * Strategy (deny-overrides):
   *  1. Topological sort — respect dependency ordering.
   *  2. For each node in sort order: if it matches, check effect.
   *     - DENY → return immediately (deny overrides).
   *     - ALLOW → flag as allowed but continue (later nodes may deny).
   *  3. After all nodes: return ALLOW if any matched, else DENY.
   *
   * Returns the decision and the policy node that triggered it (if any).
   */
  evaluate(params: PermissionCheck): EvaluationResult {
    const sortResult = this.topologicalSort();

    if (!sortResult.success) {
      return {
        allowed: false,
        reason: `Policy DAG cycle detected: ${sortResult.error}`,
      };
    }

    let allowMatched: PolicyNode | undefined;

    for (const node of sortResult.sorted) {
      if (!node.match(params)) continue;

      if (node.effect === PermissionEffect.DENY) {
        return {
          allowed: false,
          reason: `Denied by policy: ${node.description ?? node.id}`,
          matchedPolicy: node,
        };
      }

      if (!allowMatched) {
        allowMatched = node;
      }
    }

    if (allowMatched) {
      return {
        allowed: true,
        reason: `Allowed by policy: ${allowMatched.description ?? allowMatched.id}`,
        matchedPolicy: allowMatched,
      };
    }

    return { allowed: false, reason: 'No matching policy' };
  }
}
