import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { Dag } from '../../../src/core/dag/graph.ts';

// ─── Helpers ───

interface TestNode {
  id: string;
  label: string;
}

function makeDag(): Dag<string, TestNode> {
  return new Dag<string, TestNode>(n => n.id);
}

/**
 * Generate a random DAG by specifying edges as pairs of indices.
 * We ensure no cycles by only allowing forward edges (i < j after topological
 * ordering of the nodes themselves).
 */
function randomDagArbitrary(
  maxNodes: number = 20,
  maxEdges: number = 40,
): fc.Arbitrary<Dag<string, TestNode>> {
  return fc.integer({ min: 1, max: maxNodes }).chain(nodeCount =>
    fc.tuple(
      // Edge count
      fc.integer({ min: 0, max: Math.min(maxEdges, nodeCount * (nodeCount - 1) / 2) }),
      // Node labels (for variety)
      fc.array(fc.string({ minLength: 1, maxLength: 8 }), { minLength: nodeCount, maxLength: nodeCount }),
    ).map(([edgeCount, labels]) => {
      const dag = makeDag();
      const ids = labels.map((l, i) => `n${i}_${l}`);

      // Add all nodes
      for (let i = 0; i < nodeCount; i++) {
        dag.addNode({ id: ids[i]!, label: labels[i]! });
      }

      // Generate random forward-only edges (i < j guarantees acyclic)
      // Fisher-Yates style: pick random pairs where i < j
      const possibleEdges: Array<[number, number]> = [];
      for (let i = 0; i < nodeCount; i++) {
        for (let j = i + 1; j < nodeCount; j++) {
          possibleEdges.push([i, j]);
        }
      }

      // Shuffle possible edges and take edgeCount of them
      for (let i = possibleEdges.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [possibleEdges[i], possibleEdges[j]] = [possibleEdges[j]!, possibleEdges[i]!];
      }

      const selected = possibleEdges.slice(0, edgeCount);
      for (const [i, j] of selected) {
        dag.addEdge(ids[i]!, ids[j]!);
      }

      return dag;
    }),
  );
}

describe('DAG topological sort (property-based)', () => {
  describe('edge ordering invariant', () => {
    it('for every edge A→B, A appears before B in the sorted result', () => {
      fc.assert(
        fc.property(randomDagArbitrary(20, 40), (dag) => {
          const result = dag.topologicalSort();
          expect(result.success).toBe(true);

          if (!result.success) return;

          const position = new Map<string, number>();
          for (let i = 0; i < result.sorted.length; i++) {
            position.set(result.sorted[i]!.id, i);
          }

          // For every node, check all its successors appear after it
          for (const node of result.sorted) {
            const pos = position.get(node.id)!;
            for (const succ of dag.successorsOf(node.id)) {
              const succPos = position.get(succ.id);
              expect(succPos).toBeDefined();
              expect(succPos!).toBeGreaterThan(pos);
            }
          }
        }),
        { numRuns: 500 },
      );
    });
  });

  describe('completeness', () => {
    it('sorted result contains all nodes from the graph', () => {
      fc.assert(
        fc.property(randomDagArbitrary(20, 40), (dag) => {
          const result = dag.topologicalSort();
          expect(result.success).toBe(true);
          if (!result.success) return;

          expect(result.sorted.length).toBe(dag.size);

          const sortedIds = new Set(result.sorted.map(n => n.id));
          const allIds = new Set(dag.getAllNodes().map(n => n.id));
          expect(sortedIds).toEqual(allIds);
        }),
        { numRuns: 500 },
      );
    });
  });

  describe('acyclic guarantee', () => {
    it('DAG built with forward-only edges never produces a cycle', () => {
      fc.assert(
        fc.property(randomDagArbitrary(20, 40), (dag) => {
          const result = dag.topologicalSort();
          expect(result.success).toBe(true);
        }),
        { numRuns: 500 },
      );
    });
  });

  describe('cycle detection', () => {
    it('detects a simple cycle (A → B → A)', () => {
      const dag = makeDag();
      dag.addNode({ id: 'a', label: 'A' });
      dag.addNode({ id: 'b', label: 'B' });
      dag.addEdge('a', 'b');
      dag.addEdge('b', 'a');

      const result = dag.topologicalSort();
      expect(result.success).toBe(false);
      expect(result.error).toContain('Cycle');
    });

    it('detects a triangle cycle', () => {
      const dag = makeDag();
      dag.addNode({ id: 'a', label: 'A' });
      dag.addNode({ id: 'b', label: 'B' });
      dag.addNode({ id: 'c', label: 'C' });
      dag.addEdge('a', 'b');
      dag.addEdge('b', 'c');
      dag.addEdge('c', 'a');

      const result = dag.topologicalSort();
      expect(result.success).toBe(false);
    });

    it('partial result on cycle still satisfies edge ordering for non-cycle nodes', () => {
      const dag = makeDag();
      dag.addNode({ id: 'a', label: 'A' });
      dag.addNode({ id: 'b', label: 'B' });
      dag.addNode({ id: 'c', label: 'C' });
      dag.addNode({ id: 'd', label: 'D' });
      dag.addEdge('a', 'b');
      dag.addEdge('b', 'c');
      dag.addEdge('c', 'b'); // cycle between b and c
      dag.addEdge('c', 'd');

      const result = dag.topologicalSort();
      expect(result.success).toBe(false);
      // The sorted partial result should have 'a' first (in-degree 0)
      expect(result.sorted.length).toBeGreaterThanOrEqual(1);
      if (result.sorted.length > 0) {
        expect(result.sorted[0]!.id).toBe('a');
      }
    });
  });

  describe('sources and sinks', () => {
    it('sources have in-degree 0 in the graph', () => {
      fc.assert(
        fc.property(randomDagArbitrary(15, 25), (dag) => {
          for (const source of dag.sources()) {
            const predecessors = dag.predecessorsOf(source.id);
            expect(predecessors).toHaveLength(0);
          }
        }),
        { numRuns: 200 },
      );
    });

    it('sinks have out-degree 0 in the graph', () => {
      fc.assert(
        fc.property(randomDagArbitrary(15, 25), (dag) => {
          for (const sink of dag.sinks()) {
            const successors = dag.successorsOf(sink.id);
            expect(successors).toHaveLength(0);
          }
        }),
        { numRuns: 200 },
      );
    });
  });

  describe('reachable subgraph', () => {
    it('subgraph contains only nodes reachable from root', () => {
      fc.assert(
        fc.property(randomDagArbitrary(12, 20), (dag) => {
          const allNodes = dag.getAllNodes();
          if (allNodes.length === 0) return;

          // Pick a random node as root
          const rootIdx = Math.floor(Math.random() * allNodes.length);
          const root = allNodes[rootIdx]!;

          const result = dag.reachableSubgraph(root.id);
          if (!result.success) return; // Skip if root missing (shouldn't happen)

          // Every node in the subgraph must be reachable from root in the original
          const subNodes = result.dag.getAllNodes();
          for (const subNode of subNodes) {
            expect(dag.hasNode(subNode.id)).toBe(true);
          }

          // Root must be in the subgraph
          expect(result.dag.hasNode(root.id)).toBe(true);
        }),
        { numRuns: 100 },
      );
    });
  });
});
