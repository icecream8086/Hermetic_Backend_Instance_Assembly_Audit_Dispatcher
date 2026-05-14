import type { TopoSortResult } from './interfaces.ts';

/**
 * Generic directed acyclic graph base class.
 *
 * Nodes are identified by `TId`. The key function `getId` is provided at construction
 * and is called for each node to extract its identity. Edges are directed `from` → `to`.
 * In topological sort, nodes with in-degree 0 are emitted first.
 *
 * Extend this class to add domain-specific query methods, custom validation, or
 * persistence logic. Subclasses have `protected` access to the internal maps.
 *
 * @example
 * ```ts
 * class TaskDag extends Dag<string, { id: string; deps: string[] }> {
 *   constructor() {
 *     super(n => n.id);
 *   }
 *
 *   addWithDependencies(task: { id: string; deps: string[] }): void {
 *     this.addNode(task);
 *     for (const dep of task.deps) {
 *       this.addEdge(task.id, dep);
 *     }
 *   }
 * }
 * ```
 */
export class Dag<TId, TNode> {
  /** Key extractor — subclasses may access to build custom queries. */
  protected readonly getId: (node: TNode) => TId;
  /** Node storage: id → node. */
  protected readonly nodes = new Map<TId, TNode>();
  /** Forward edges: from → Set{to}. */
  protected readonly outgoing = new Map<TId, Set<TId>>();
  /** Reverse edges: to → Set{from}. */
  protected readonly incoming = new Map<TId, Set<TId>>();

  constructor(getId: (node: TNode) => TId) {
    this.getId = getId;
  }

  // ─── Mutation ───

  /** Add a node. Replaces any existing node with the same id. */
  addNode(node: TNode): void {
    const id = this.getId(node);
    this.nodes.set(id, node);
    if (!this.outgoing.has(id)) this.outgoing.set(id, new Set());
    if (!this.incoming.has(id)) this.incoming.set(id, new Set());
  }

  /**
   * Add a directed edge `from` → `to`.
   * Both nodes must already exist (call `addNode` first).
   */
  addEdge(from: TId, to: TId): void {
    if (!this.nodes.has(from)) throw new TypeError(`Dag.addEdge: source node "${from}" does not exist`);
    if (!this.nodes.has(to)) throw new TypeError(`Dag.addEdge: target node "${to}" does not exist`);

    this.outgoing.get(from)!.add(to);
    this.incoming.get(to)!.add(from);
  }

  // ─── Queries ───

  hasNode(id: TId): boolean {
    return this.nodes.has(id);
  }

  getNode(id: TId): TNode | undefined {
    return this.nodes.get(id);
  }

  /** Returns all nodes. Order is undefined. */
  getAllNodes(): readonly TNode[] {
    return [...this.nodes.values()];
  }

  /** Number of nodes in the graph. */
  get size(): number {
    return this.nodes.size;
  }

  /** Nodes that have a direct edge TO `id` (incoming neighbours). */
  predecessorsOf(id: TId): readonly TNode[] {
    const result: TNode[] = [];
    for (const from of this.incoming.get(id) ?? []) {
      const node = this.nodes.get(from);
      if (node) result.push(node);
    }
    return result;
  }

  /** Nodes that `id` has a direct edge TO (outgoing neighbours). */
  successorsOf(id: TId): readonly TNode[] {
    const result: TNode[] = [];
    for (const to of this.outgoing.get(id) ?? []) {
      const node = this.nodes.get(to);
      if (node) result.push(node);
    }
    return result;
  }

  // ─── Algorithms ───

  /**
   * Topological sort via Kahn's algorithm.
   * Returns nodes sorted so that every node appears before the nodes that depend on it
   * (i.e. if A → B, A appears before B).
   *
   * On success: `{ success: true, sorted: [...] }`
   * On cycle:  `{ success: false, sorted: [...partial...], error: "..." }`
   */
  topologicalSort(): TopoSortResult<TNode> {
    const inDegree = new Map<TId, number>();

    // initialise in-degree for every node
    for (const id of this.nodes.keys()) {
      inDegree.set(id, 0);
    }

    // count incoming edges
    for (const [, targets] of this.outgoing) {
      for (const to of targets) {
        inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
      }
    }

    // seed queue with zero in-degree nodes
    const queue: TId[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) queue.push(id);
    }

    const sorted: TNode[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      sorted.push(this.nodes.get(id)!);

      for (const to of this.outgoing.get(id) ?? []) {
        const newDegree = (inDegree.get(to) ?? 1) - 1;
        inDegree.set(to, newDegree);
        if (newDegree === 0) queue.push(to);
      }
    }

    if (sorted.length < this.nodes.size) {
      const remaining = [...this.nodes.keys()].filter(id => (inDegree.get(id) ?? 0) > 0);
      return {
        success: false,
        sorted,
        error: `Cycle detected: could not sort ${remaining.length} node(s) [${remaining.join(', ')}]`,
      };
    }

    return { success: true, sorted };
  }

  /**
   * Extract the subgraph reachable from `root` using depth-first search.
   * Follows outgoing edges from root to find all transitive successors.
   */
  reachableSubgraph(root: TId): { dag: Dag<TId, TNode>; error: string | undefined } {
    const subgraph = new Dag<TId, TNode>(this.getId);
    const path = new Set<TId>();
    const visited = new Set<TId>();

    const visit = (id: TId): string | undefined => {
      if (!this.nodes.has(id)) return `Node "${id}" not found`;
      if (path.has(id)) return `Cycle detected: "${id}" is visited twice on the same path`;
      if (visited.has(id)) return;

      path.add(id);
      visited.add(id);
      subgraph.addNode(this.nodes.get(id)!);

      for (const to of this.outgoing.get(id) ?? []) {
        const err = visit(to);
        if (err) return err;
        subgraph.addEdge(id, to);
      }

      path.delete(id);
    };

    const error = visit(root);
    return { dag: subgraph, error };
  }
}
