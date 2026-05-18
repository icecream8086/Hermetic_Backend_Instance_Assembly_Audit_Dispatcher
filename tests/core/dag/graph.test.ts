import { describe, it, expect } from 'vitest';
import { Dag, buildDag } from '../../../src/core/dag/graph.ts';

// ─── Test helpers ───

interface TestNode {
  readonly id: string;
  readonly label: string;
}

/** Expose protected internals for white-box inspection. */
class TestDag extends Dag<string, TestNode> {
  constructor() { super(n => n.id); }

  inspectNodes(): ReadonlyMap<string, TestNode> { return this.nodes; }
  inspectOutgoing(): ReadonlyMap<string, Set<string>> { return this.outgoing; }
  inspectIncoming(): ReadonlyMap<string, Set<string>> { return this.incoming; }
  getIdOf(node: TestNode): string { return this.getId(node); }
}

function node(id: string, label?: string): TestNode {
  return { id, label: label ?? id };
}

// ─── Construction & mutation ───

describe('Dag (white-box)', () => {
  describe('addNode', () => {
    it('stores the node and initialises empty adjacency sets', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));

      const nodes = dag.inspectNodes();
      expect(nodes.size).toBe(1);
      expect(nodes.get('a')).toEqual({ id: 'a', label: 'a' });

      expect(dag.inspectOutgoing().get('a')).toEqual(new Set());
      expect(dag.inspectIncoming().get('a')).toEqual(new Set());
    });

    it('replaces an existing node with the same id', () => {
      const dag = new TestDag();
      dag.addNode(node('a', 'first'));
      dag.addNode(node('a', 'second'));

      expect(dag.inspectNodes().get('a')!.label).toBe('second');
      // adjacency sets should not grow on replacement
      expect(dag.inspectOutgoing().size).toBe(1);
      expect(dag.inspectIncoming().size).toBe(1);
    });

    it('does not share adjacency sets between different ids', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      dag.addNode(node('b'));

      const out = dag.inspectOutgoing();
      expect(out.get('a')).not.toBe(out.get('b'));
    });

    it('getId returns the extracted key', () => {
      const dag = new TestDag();
      const n = node('x', 'hello');
      expect(dag.getIdOf(n)).toBe('x');
    });
  });

  describe('addEdge', () => {
    it('registers bidirectional adjacency (outgoing + incoming)', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      dag.addNode(node('b'));
      dag.addEdge('a', 'b');

      const out = dag.inspectOutgoing();
      expect([...out.get('a')!]).toEqual(['b']);

      const inc = dag.inspectIncoming();
      expect([...inc.get('b')!]).toEqual(['a']);
    });

    it('throws when source node does not exist', () => {
      const dag = new TestDag();
      dag.addNode(node('b'));
      expect(() => dag.addEdge('a', 'b')).toThrow('does not exist');
    });

    it('throws when target node does not exist', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      expect(() => dag.addEdge('a', 'b')).toThrow('does not exist');
    });

    it('multiple edges from same source accumulate in the outgoing set', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      dag.addNode(node('b'));
      dag.addNode(node('c'));
      dag.addEdge('a', 'b');
      dag.addEdge('a', 'c');

      const out = dag.inspectOutgoing();
      expect(out.get('a')).toEqual(new Set(['b', 'c']));
    });

    it('duplicate edge is idempotent (Set semantics)', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      dag.addNode(node('b'));
      dag.addEdge('a', 'b');
      dag.addEdge('a', 'b'); // duplicate

      expect(dag.inspectOutgoing().get('a')).toEqual(new Set(['b']));
      expect(dag.inspectIncoming().get('b')).toEqual(new Set(['a']));
    });
  });

  describe('hasNode / getNode / getAllNodes / size', () => {
    it('hasNode returns true for existing node', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      expect(dag.hasNode('a')).toBe(true);
      expect(dag.hasNode('b')).toBe(false);
    });

    it('getNode returns the node or undefined', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      expect(dag.getNode('a')).toEqual({ id: 'a', label: 'a' });
      expect(dag.getNode('b')).toBeUndefined();
    });

    it('getAllNodes returns all nodes; size tracks count', () => {
      const dag = new TestDag();
      expect(dag.size).toBe(0);
      expect(dag.getAllNodes()).toEqual([]);

      dag.addNode(node('a'));
      dag.addNode(node('b'));
      expect(dag.size).toBe(2);
      expect(dag.getAllNodes()).toHaveLength(2);
    });
  });

  describe('predecessorsOf / successorsOf', () => {
    it('returns empty arrays for isolate node', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      expect(dag.predecessorsOf('a')).toEqual([]);
      expect(dag.successorsOf('a')).toEqual([]);
    });

    it('predecessorsOf returns nodes that point TO the given id', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      dag.addNode(node('b'));
      dag.addEdge('a', 'b');

      expect(dag.predecessorsOf('b')).toEqual([{ id: 'a', label: 'a' }]);
      expect(dag.predecessorsOf('a')).toEqual([]);
    });

    it('successorsOf returns nodes the given id points TO', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      dag.addNode(node('b'));
      dag.addEdge('a', 'b');

      expect(dag.successorsOf('a')).toEqual([{ id: 'b', label: 'b' }]);
      expect(dag.successorsOf('b')).toEqual([]);
    });

    it('returns empty array for non-existent id', () => {
      const dag = new TestDag();
      expect(dag.predecessorsOf('x')).toEqual([]);
      expect(dag.successorsOf('x')).toEqual([]);
    });
  });

  // ─── Topological sort ───

  describe('topologicalSort', () => {
    it('sorts a linear chain (A → B → C)', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      dag.addNode(node('b'));
      dag.addNode(node('c'));
      dag.addEdge('a', 'b');
      dag.addEdge('b', 'c');

      const result = dag.topologicalSort();
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.sorted.map(n => n.id)).toEqual(['a', 'b', 'c']);
    });

    it('sorts a diamond (A → B, A → C, B → D, C → D)', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      dag.addNode(node('b'));
      dag.addNode(node('c'));
      dag.addNode(node('d'));
      dag.addEdge('a', 'b');
      dag.addEdge('a', 'c');
      dag.addEdge('b', 'd');
      dag.addEdge('c', 'd');

      const result = dag.topologicalSort();
      expect(result.success).toBe(true);
      if (!result.success) return;
      const ids = result.sorted.map(n => n.id);
      // a before b and c; b and c before d
      expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'));
      expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('c'));
      expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('d'));
      expect(ids.indexOf('c')).toBeLessThan(ids.indexOf('d'));
    });

    it('handles a single node (trivial)', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      const result = dag.topologicalSort();
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.sorted).toHaveLength(1);
      expect(result.sorted[0]!.id).toBe('a');
    });

    it('handles two independent nodes (no edges)', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      dag.addNode(node('b'));
      const result = dag.topologicalSort();
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.sorted).toHaveLength(2);
    });

    it('detects a simple cycle (A → B → A)', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      dag.addNode(node('b'));
      dag.addEdge('a', 'b');
      dag.addEdge('b', 'a');

      const result = dag.topologicalSort();
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('Cycle detected');
    });

    it('detects a self-loop (A → A)', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      dag.addEdge('a', 'a');

      const result = dag.topologicalSort();
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('Cycle detected');
    });

    it('detects a complex cycle (A → B → C → A)', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      dag.addNode(node('b'));
      dag.addNode(node('c'));
      dag.addEdge('a', 'b');
      dag.addEdge('b', 'c');
      dag.addEdge('c', 'a');

      const result = dag.topologicalSort();
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('Cycle detected');
    });

    it('returns partial result when cycle exists', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      dag.addNode(node('b'));
      dag.addNode(node('c'));
      dag.addEdge('a', 'b');
      dag.addEdge('b', 'c');
      dag.addEdge('c', 'b'); // cycle b↔c

      const result = dag.topologicalSort();
      expect(result.success).toBe(false);
      if (result.success) return;
      // At least 'a' should be in the partial result
      expect(result.sorted.length).toBeGreaterThan(0);
      expect(result.sorted.some(n => n.id === 'a')).toBe(true);
    });

    it('preserves invariant: for every edge A→B, A appears before B', () => {
      const dag = new TestDag();
      const ids = ['x1', 'x2', 'x3', 'x4', 'x5'];
      for (const id of ids) dag.addNode(node(id));

      // build a more complex DAG
      dag.addEdge('x1', 'x2');
      dag.addEdge('x1', 'x3');
      dag.addEdge('x2', 'x4');
      dag.addEdge('x3', 'x4');
      dag.addEdge('x4', 'x5');

      const result = dag.topologicalSort();
      expect(result.success).toBe(true);
      if (!result.success) return;

      const order = new Map(result.sorted.map((n, i) => [n.id, i]));
      // check all edges
      expect(order.get('x1')!).toBeLessThan(order.get('x2')!);
      expect(order.get('x1')!).toBeLessThan(order.get('x3')!);
      expect(order.get('x2')!).toBeLessThan(order.get('x4')!);
      expect(order.get('x3')!).toBeLessThan(order.get('x4')!);
      expect(order.get('x4')!).toBeLessThan(order.get('x5')!);
    });

    it('in-degree is correctly computed from outgoing edges', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      dag.addNode(node('b'));
      dag.addNode(node('c'));
      dag.addEdge('a', 'b');
      dag.addEdge('a', 'c');

      const result = dag.topologicalSort();
      expect(result.success).toBe(true);
      if (!result.success) return;

      // 'a' has in-degree 0 (no incoming edges) → should be first
      expect(result.sorted[0]!.id).toBe('a');
    });

    it('disconnected subgraphs are all included in the result', () => {
      const dag = new TestDag();
      // two independent chains
      dag.addNode(node('a'));
      dag.addNode(node('b'));
      dag.addNode(node('x'));
      dag.addNode(node('y'));
      dag.addEdge('a', 'b');
      dag.addEdge('x', 'y');

      const result = dag.topologicalSort();
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.sorted).toHaveLength(4);
      // both chains are valid
      const ids = result.sorted.map(n => n.id);
      expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'));
      expect(ids.indexOf('x')).toBeLessThan(ids.indexOf('y'));
    });

    it('handles a large DAG (100 nodes, linear chain)', () => {
      const dag = new TestDag();
      for (let i = 0; i < 100; i++) {
        dag.addNode(node(`n${i}`));
        if (i > 0) dag.addEdge(`n${i - 1}`, `n${i}`);
      }
      const result = dag.topologicalSort();
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.sorted).toHaveLength(100);
      // verify order
      for (let i = 0; i < 100; i++) {
        expect(result.sorted[i]!.id).toBe(`n${i}`);
      }
    });
  });

  // ─── reachableSubgraph ───

  describe('reachableSubgraph', () => {
    it('extracts reachable nodes from root following outgoing edges', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      dag.addNode(node('b'));
      dag.addNode(node('c'));
      dag.addNode(node('d'));
      dag.addEdge('a', 'b');
      dag.addEdge('a', 'c');
      // 'd' is not reachable from 'a'

      const result = dag.reachableSubgraph('a');
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.dag.size).toBe(3);
      expect(result.dag.hasNode('a')).toBe(true);
      expect(result.dag.hasNode('b')).toBe(true);
      expect(result.dag.hasNode('c')).toBe(true);
      expect(result.dag.hasNode('d')).toBe(false);
    });

    it('preserves edges in the subgraph', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      dag.addNode(node('b'));
      dag.addNode(node('c'));
      dag.addEdge('a', 'b');
      dag.addEdge('b', 'c');

      const result = dag.reachableSubgraph('a');
      expect(result.success).toBe(true);
      if (!result.success) return;
      const ids = result.dag.getAllNodes().map(n => n.id).sort();
      expect(ids).toEqual(['a', 'b', 'c']);

      const sortResult = result.dag.topologicalSort();
      expect(sortResult.success).toBe(true);
    });

    it('returns error for non-existent root', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      const result = dag.reachableSubgraph('x');
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('not found');
    });

    it('returns error on cycle during DFS traversal', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      dag.addNode(node('b'));
      dag.addNode(node('c'));
      dag.addEdge('a', 'b');
      dag.addEdge('b', 'c');
      dag.addEdge('c', 'a');

      const result = dag.reachableSubgraph('a');
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('Cycle detected');
    });

    it('subgraph from a leaf returns only that node', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      dag.addNode(node('b'));
      dag.addEdge('a', 'b');

      const result = dag.reachableSubgraph('b');
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.dag.size).toBe(1);
      expect(result.dag.hasNode('b')).toBe(true);
    });

    it('subgraph inherits parent construction (same getId)', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      const result = dag.reachableSubgraph('a');
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.dag.size).toBe(1);
      expect(result.dag.hasNode('a')).toBe(true);
    });
  });

  // ─── sources / sinks ───

  describe('sources', () => {
    it('returns empty array for empty graph', () => {
      const dag = new TestDag();
      expect(dag.sources()).toEqual([]);
    });

    it('single isolated node is a source', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      expect(dag.sources().map(n => n.id)).toEqual(['a']);
    });

    it('excludes nodes with incoming edges', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      dag.addNode(node('b'));
      dag.addEdge('a', 'b');
      expect(dag.sources().map(n => n.id)).toEqual(['a']);
    });

    it('returns multiple sources in disconnected graph', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      dag.addNode(node('b'));
      dag.addNode(node('c'));
      dag.addEdge('a', 'c');
      expect(dag.sources().map(n => n.id).sort()).toEqual(['a', 'b']);
    });
  });

  describe('sinks', () => {
    it('returns empty array for empty graph', () => {
      const dag = new TestDag();
      expect(dag.sinks()).toEqual([]);
    });

    it('single isolated node is a sink', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      expect(dag.sinks().map(n => n.id)).toEqual(['a']);
    });

    it('excludes nodes with outgoing edges', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      dag.addNode(node('b'));
      dag.addEdge('a', 'b');
      expect(dag.sinks().map(n => n.id)).toEqual(['b']);
    });

    it('returns multiple sinks in disconnected graph', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      dag.addNode(node('b'));
      dag.addNode(node('c'));
      dag.addEdge('a', 'c');
      expect(dag.sinks().map(n => n.id).sort()).toEqual(['b', 'c']);
    });
  });

  // ─── buildDag ───

  describe('buildDag', () => {
    it('builds a DAG from a key-value store with no references', () => {
      const store = new Map<string, TestNode>([
        ['a', node('a')],
        ['b', node('b')],
      ]);
      const { dag, errors } = buildDag(
        'a',
        id => store.get(id),
        () => [],
        n => n.id,
      );
      expect(errors).toEqual([]);
      expect(dag.size).toBe(1);
      expect(dag.hasNode('a')).toBe(true);
    });

    it('follows references to build the full graph', () => {
      const store = new Map<string, TestNode>([
        ['a', node('a')],
        ['b', node('b')],
        ['c', node('c')],
      ]);
      const { dag, errors } = buildDag(
        'a',
        id => store.get(id),
        n => n.id === 'a' ? ['b', 'c'] : [],
        n => n.id,
      );
      expect(errors).toEqual([]);
      expect(dag.size).toBe(3);
      expect(dag.hasNode('a')).toBe(true);
      expect(dag.hasNode('b')).toBe(true);
      expect(dag.hasNode('c')).toBe(true);
    });

    it('adds parent→child edges for references', () => {
      const store = new Map<string, TestNode>([
        ['a', node('a')],
        ['b', node('b')],
      ]);
      const { dag, errors } = buildDag(
        'a',
        id => store.get(id),
        n => n.id === 'a' ? ['b'] : [],
        n => n.id,
      );
      expect(errors).toEqual([]);
      const succ = dag.successorsOf('a');
      expect(succ).toHaveLength(1);
      expect(succ[0]!.id).toBe('b');
    });

    it('reports error when root node is missing', () => {
      const store = new Map<string, TestNode>();
      const { errors } = buildDag(
        'x',
        id => store.get(id),
        () => [],
        n => n.id,
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]!.id).toBe('x');
      expect(errors[0]!.message).toContain('not found');
    });

    it('reports error when a referenced node is missing', () => {
      const store = new Map<string, TestNode>([
        ['a', node('a')],
      ]);
      const { dag, errors } = buildDag(
        'a',
        id => store.get(id),
        n => n.id === 'a' ? ['b'] : [],
        n => n.id,
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]!.id).toBe('b');
      expect(dag.hasNode('a')).toBe(true);
    });

    it('detects and reports cycles', () => {
      const store = new Map<string, TestNode>([
        ['a', node('a')],
        ['b', node('b')],
      ]);
      const { errors } = buildDag(
        'a',
        id => store.get(id),
        n => n.id === 'a' ? ['b'] : ['a'],
        n => n.id,
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain('Circular dependency');
    });

    it('returns empty errors for graph with independent nodes', () => {
      const store = new Map<string, TestNode>([
        ['a', node('a')],
        ['b', node('b')],
      ]);
      const { dag, errors } = buildDag(
        'b',
        id => store.get(id),
        () => [],
        n => n.id,
      );
      expect(errors).toEqual([]);
      expect(dag.size).toBe(1);
      expect(dag.hasNode('b')).toBe(true);
    });
  });

  // ─── Inheritance (base class contract) ───

  describe('inheritance (protected member access)', () => {
    it('subclass can access protected nodes map directly', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      expect(dag.inspectNodes().has('a')).toBe(true);
    });

    it('subclass can access protected outgoing map directly', () => {
      const dag = new TestDag();
      dag.addNode(node('a'));
      dag.addNode(node('b'));
      dag.addEdge('a', 'b');
      expect([...dag.inspectOutgoing().get('a')!]).toEqual(['b']);
    });

    it('subclass can override addNode with custom behaviour', () => {
      class ValidatingDag extends TestDag {
        addNode(n: TestNode): void {
          if (!n.id) throw new Error('id required');
          if (!n.label) throw new Error('label required');
          super.addNode(n);
        }
      }
      const dag = new ValidatingDag();
      expect(() => dag.addNode({ id: '', label: 'x' })).toThrow('id required');
      expect(() => dag.addNode({ id: 'a', label: '' })).toThrow('label required');
      dag.addNode(node('a'));
      expect(dag.hasNode('a')).toBe(true);
    });

    it('subclass can add domain-specific query methods', () => {
      class LabelledDag extends TestDag {
        findByLabel(label: string): TestNode | undefined {
          for (const node of this.nodes.values()) {
            if (node.label === label) return node;
          }
        }
      }
      const dag = new LabelledDag();
      dag.addNode(node('a', 'alpha'));
      dag.addNode(node('b', 'beta'));
      expect(dag.findByLabel('alpha')!.id).toBe('a');
      expect(dag.findByLabel('gamma')).toBeUndefined();
    });
  });
});
