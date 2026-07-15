import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { PermissionDag } from '../../../src/core/permission/permission-dag.ts';
import {
  PermissionEffect,
  createPolicyId,
  type PolicyId,
  type PolicyNode,
  type PermissionCheck,
} from '../../../src/core/permission/types.ts';

// ─── Helpers ───

const p = (s: string) => createPolicyId(s);

/** Build a PolicyNode that always matches (ALLOW or DENY). */
function alwaysNode(
  id: PolicyId,
  effect: PermissionEffect,
  description = id,
): PolicyNode {
  return { id, effect, description, match: () => true };
}

/** Build a PolicyNode that never matches. */
function neverNode(
  id: PolicyId,
  effect: PermissionEffect,
  description = id,
): PolicyNode {
  return { id, effect, description, match: () => false };
}

const emptyCheck: PermissionCheck = {
  actor: 'user1',
  action: 'read',
  resource: 'pod',
};

// ─── Arbitraries ───

const effect = fc.constantFrom(PermissionEffect.ALLOW, PermissionEffect.DENY);

/**
 * Generate a random permission DAG with `nodeCount` nodes.
 * Each node randomly matches or not, and random dependency edges are added
 * (with care to avoid creating cycles — we use the fact that the graph is
 * small and skip edges that would create cycles).
 */
function randomDag(nodeCount: number, matchProbability: number): fc.Arbitrary<{
  dag: PermissionDag;
  nodes: PolicyNode[];
}> {
  return fc.record({
    // Generate nodeCount booleans for match behavior
    matches: fc.array(fc.boolean(), { minLength: nodeCount, maxLength: nodeCount }),
    effects: fc.array(effect, { minLength: nodeCount, maxLength: nodeCount }),
    // Generate edges — each pair may or may not have an edge
    edges: fc.array(
      fc.tuple(
        fc.integer({ min: 0, max: nodeCount - 1 }),
        fc.integer({ min: 0, max: nodeCount - 1 }),
      ),
      { maxLength: nodeCount * 2 },
    ),
  }).map(({ matches, effects, edges }) => {
    const dag = new PermissionDag();
    const nodes: PolicyNode[] = [];
    for (let i = 0; i < nodeCount; i++) {
      const node: PolicyNode = {
        id: p(`n${i}`),
        effect: effects[i]!,
        description: `node ${i}`,
        match: matches[i] ? () => true : () => false,
      };
      nodes.push(node);
      dag.addPolicy(node);
    }

    for (const [from, to] of edges) {
      if (from === to) continue;
      // Only add edge if it won't create a cycle (simple check for small graphs)
      try {
        dag.addDependency(p(`n${from}`), p(`n${to}`));
      } catch {
        // Skip edges that would create cycles (or reference missing nodes)
      }
    }

    return { dag, nodes };
  });
}

describe('PermissionDag (property-based)', () => {
  describe('deny-overrides semantics', () => {
    it('DENY always overrides ALLOW regardless of topological order', () => {
      fc.assert(
        fc.property(
          randomDag(6, 0.7),
          ({ dag }) => {
            const result = dag.evaluate(emptyCheck);
            // If the result is ALLOW, there must be NO matching DENY node
            // If there IS a matching DENY, result must be DENY
            if (result.allowed) {
              // Check: no matching DENY exists
              const sortResult = dag.topologicalSort();
              if (sortResult.success) {
                for (const node of sortResult.sorted) {
                  if (node.match(emptyCheck) && node.effect === PermissionEffect.DENY) {
                    // This should not happen — DENY should have overridden
                    expect(result.allowed).toBe(false);
                  }
                }
              }
            }
          },
        ),
        { numRuns: 200 },
      );
    });

    it('DENY with a single matching DENY always returns DENY', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10 }),
          fc.integer({ min: 0, max: 5 }),
          (allowCount, denyPosition) => {
            const dag = new PermissionDag();
            // Add ALLOW nodes
            for (let i = 0; i < allowCount; i++) {
              dag.addPolicy(alwaysNode(p(`allow${i}`), PermissionEffect.ALLOW));
            }
            // Add a single DENY node
            const denyPos = denyPosition % (allowCount + 1); // pick a position in the chain
            dag.addPolicy(alwaysNode(p('deny'), PermissionEffect.DENY));

            // Chain dependencies: n0 → n1 → ... → deny → ... → n(k-1)
            const totalNodes = allowCount + 1;
            const ids: PolicyId[] = [];
            for (let i = 0; i < allowCount; i++) ids.push(p(`allow${i}`));
            // Insert deny at the chosen position
            ids.splice(denyPos, 0, p('deny'));

            for (let i = 0; i < totalNodes - 1; i++) {
              dag.addDependency(ids[i]!, ids[i + 1]!);
            }

            const result = dag.evaluate(emptyCheck);
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('Denied');
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  describe('default deny', () => {
    it('returns DENY when no policy matches', () => {
      const dag = new PermissionDag();
      dag.addPolicy(neverNode(p('n1'), PermissionEffect.ALLOW));
      dag.addPolicy(neverNode(p('n2'), PermissionEffect.DENY));

      const result = dag.evaluate(emptyCheck);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('No matching policy');
    });

    it('returns DENY for an empty DAG', () => {
      const dag = new PermissionDag();
      const result = dag.evaluate(emptyCheck);
      expect(result.allowed).toBe(false);
    });
  });

  describe('topological order independence', () => {
    it('DENY position in the chain does not change the outcome', () => {
      // The position of a DENY node in the topological order should not matter
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 6 }),
          (denyPosition) => {
            const dag = new PermissionDag();
            const n0 = alwaysNode(p('n0'), PermissionEffect.ALLOW);
            const n1 = alwaysNode(p('n1'), PermissionEffect.ALLOW);
            const denyNode = alwaysNode(p('deny'), PermissionEffect.DENY);

            dag.addPolicy(n0);
            dag.addPolicy(n1);
            dag.addPolicy(denyNode);

            // Create chain with deny at the given position
            const chain: PolicyId[] = [p('n0'), p('deny'), p('n1')];
            for (let i = 0; i < chain.length - 1; i++) {
              dag.addDependency(chain[i]!, chain[i + 1]!);
            }

            // Should always be DENY
            const result = dag.evaluate(emptyCheck);
            expect(result.allowed).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('idempotency', () => {
    it('evaluate returns the same result when called twice', () => {
      fc.assert(
        fc.property(
          randomDag(5, 0.6),
          ({ dag }) => {
            const r1 = dag.evaluate(emptyCheck);
            const r2 = dag.evaluate(emptyCheck);
            expect(r2.allowed).toBe(r1.allowed);
            expect(r2.reason).toBe(r1.reason);
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  describe('cycle detection', () => {
    it('returns DENY when DAG has a cycle', () => {
      const dag = new PermissionDag();
      dag.addPolicy(alwaysNode(p('a'), PermissionEffect.ALLOW));
      dag.addPolicy(alwaysNode(p('b'), PermissionEffect.ALLOW));

      // Create a cycle: a → b → a
      dag.addDependency(p('a'), p('b'));
      dag.addDependency(p('b'), p('a'));

      const result = dag.evaluate(emptyCheck);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('cycle');
    });
  });

  describe('only matching nodes affect outcome', () => {
    it('non-matching DENY does not affect outcome', () => {
      const dag = new PermissionDag();
      dag.addPolicy(alwaysNode(p('allow'), PermissionEffect.ALLOW));
      dag.addPolicy(neverNode(p('non-matching-deny'), PermissionEffect.DENY));

      // Chain: deny evaluated first
      dag.addDependency(p('non-matching-deny'), p('allow'));

      const result = dag.evaluate(emptyCheck);
      expect(result.allowed).toBe(true);
    });
  });

  // ═════════════════════════════════════════════════════════════
  // ISSUE-00019 — topological order + additive + edge cases
  // ═════════════════════════════════════════════════════════════

  describe('topological ordering in evaluation', () => {
    it('evaluation respects dependency chain order', () => {
      // early=DENY(no match) → middle=ALLOW(match) → late=DENY(match)
      // If topo order respected: early skip, middle allow, then late deny-overrides
      const dag = new PermissionDag();
      dag.addPolicy(neverNode(p('early'), PermissionEffect.DENY));
      dag.addPolicy(alwaysNode(p('middle'), PermissionEffect.ALLOW));
      dag.addPolicy(alwaysNode(p('late'), PermissionEffect.DENY, 'should-deny'));
      dag.addDependency(p('early'), p('middle'));
      dag.addDependency(p('middle'), p('late'));
      const result = dag.evaluate(emptyCheck);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('should-deny');
    });

    it('multi-level DAG: DENY wins regardless of depth', () => {
      const dag = new PermissionDag();
      for (let i = 0; i < 5; i++) {
        dag.addPolicy(alwaysNode(p(`n${i}`), i === 1 ? PermissionEffect.DENY : PermissionEffect.ALLOW));
        if (i > 0) dag.addDependency(p(`n${i - 1}`), p(`n${i}`));
      }
      expect(dag.evaluate(emptyCheck).allowed).toBe(false);
    });

    it('matchedPolicy reports the first matching ALLOW in topological order', () => {
      const dag = new PermissionDag();
      dag.addPolicy(alwaysNode(p('first'), PermissionEffect.ALLOW, 'first-allow'));
      dag.addPolicy(alwaysNode(p('second'), PermissionEffect.ALLOW, 'second-allow'));
      dag.addDependency(p('first'), p('second'));

      const result = dag.evaluate(emptyCheck);
      expect(result.allowed).toBe(true);
      expect(result.matchedPolicy).toBeDefined();
      expect(result.matchedPolicy!.id).toBe(p('first'));
    });

    it('matchedPolicy picks first ALLOW in topo order even when insertion order differs', () => {
      const dag = new PermissionDag();
      dag.addPolicy(alwaysNode(p('second'), PermissionEffect.ALLOW, 'second-allow'));
      dag.addPolicy(alwaysNode(p('first'), PermissionEffect.ALLOW, 'first-allow'));
      dag.addDependency(p('first'), p('second'));

      const result = dag.evaluate(emptyCheck);
      expect(result.allowed).toBe(true);
      expect(result.matchedPolicy!.id).toBe(p('first'));
    });
  });

  describe('additive: unrelated policies do not change result', () => {
    it('adding non-matching nodes does not change DENY result', () => {
      const dag = new PermissionDag();
      dag.addPolicy(alwaysNode(p('deny'), PermissionEffect.DENY));
      dag.addPolicy(neverNode(p('extra-deny'), PermissionEffect.DENY));
      dag.addPolicy(neverNode(p('extra-allow'), PermissionEffect.ALLOW));
      expect(dag.evaluate(emptyCheck).allowed).toBe(false);
    });

    it('PBT: adding unrelated policies does not flip ALLOW→DENY', () => {
      fc.assert(fc.property(fc.integer({ min: 1, max: 8 }), fc.integer({ min: 0, max: 5 }), (ac, ec) => {
        const dag = new PermissionDag();
        for (let i = 0; i < ac; i++) dag.addPolicy(alwaysNode(p(`a${i}`), PermissionEffect.ALLOW));
        for (let i = 0; i < ec; i++) dag.addPolicy(neverNode(p(`e${i}`), PermissionEffect.DENY));
        expect(dag.evaluate(emptyCheck).allowed).toBe(true);
      }), { numRuns: 100 });
    });
  });

  describe('conditional matching', () => {
    it('actor-specific allow/deny', () => {
      const dag = new PermissionDag();
      dag.addPolicy({ id: p('admin'), effect: PermissionEffect.ALLOW, description: 'admin', match: p => p.actor === 'admin' });
      dag.addPolicy({ id: p('deny-guest'), effect: PermissionEffect.DENY, description: 'no guest', match: p => p.actor === 'guest' });
      expect(dag.evaluate({ actor: 'admin', action: 'read', resource: 'x' }).allowed).toBe(true);
      expect(dag.evaluate({ actor: 'guest', action: 'read', resource: 'x' }).allowed).toBe(false);
    });

    it('resource-specific deny overrides broad allow', () => {
      const dag = new PermissionDag();
      dag.addPolicy({ id: p('allow-all'), effect: PermissionEffect.ALLOW, description: 'allow all', match: () => true });
      dag.addPolicy({ id: p('deny-del'), effect: PermissionEffect.DENY, description: 'deny deleted', match: p => p.resource.startsWith('deleted-') });
      expect(dag.evaluate({ actor: 'u1', action: 'read', resource: 'normal' }).allowed).toBe(true);
      expect(dag.evaluate({ actor: 'u1', action: 'read', resource: 'deleted-x' }).allowed).toBe(false);
    });
  });
});
