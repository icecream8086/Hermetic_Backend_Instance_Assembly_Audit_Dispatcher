import type { TreeNode, TreeTraversalOrder } from './interfaces.ts';

/**
 * Generic N-ary tree base class.
 *
 * Each node can hold an arbitrary number of children. Provides traversal,
 * search, and mutation primitives. Subclasses have `protected` access to
 * the root node and size counter.
 *
 * @example
 * ```ts
 * class CategoryTree extends Tree<string> {
 *   addCategory(path: string[]): TreeNode<string> {
 *     let node = this.root;
 *     if (!node) node = this.setRoot(path[0]!);
 *     for (let i = 1; i < path.length; i++) {
 *       let child = node.children.find(c => c.value === path[i]);
 *       if (!child) child = this.addChild(node, path[i]!);
 *       node = child;
 *     }
 *     return node;
 *   }
 * }
 * ```
 */
export class Tree<T> {
  protected root: TreeNode<T> | null = null;
  protected _size = 0;

  // ─── Mutation ───

  /** Set the root value. Replaces any existing tree. Returns the new root node. */
  public setRoot(value: T): TreeNode<T> {
    this.root = { value, children: [] };
    this._size = 1;
    return this.root;
  }

  /** Add a child to `parent`. Returns the new child node. */
  public addChild(parent: TreeNode<T>, value: T): TreeNode<T> {
    const child: TreeNode<T> = { value, children: [] };
    parent.children.push(child);
    this._size++;
    return child;
  }

  /**
   * Remove a node and its entire subtree from the tree.
   * Returns `true` if the node was found and removed.
   */
  public remove(node: TreeNode<T>): boolean {
    if (this.root === node) {
      this.root = null;
      this._size = 0;
      return true;
    }
    const parent = this.#findParent(node);
    if (!parent) return false;
    const idx = parent.children.indexOf(node);
    if (idx !== -1) {
      parent.children.splice(idx, 1);
      this.#subtractSize(node);
      return true;
    }
    return false;
  }

  /** Remove all nodes. */
  public clear(): void {
    this.root = null;
    this._size = 0;
  }

  // ─── Queries ───

  /** Find the first node whose value satisfies `predicate` (preorder traversal). */
  public find(predicate: (value: T) => boolean): TreeNode<T> | undefined {
    if (!this.root) return undefined;
    const stack: TreeNode<T>[] = [this.root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;
      if (predicate(node.value)) return node;
      for (let i = node.children.length - 1; i >= 0; i--) {
        const child = node.children[i];
        if (child) stack.push(child);
      }
    }
  }

  /** Traverse the tree and collect values in the specified order. */
  public traverse(order: TreeTraversalOrder): T[] {
    const result: T[] = [];
    if (!this.root) return result;

    switch (order) {
      case 'preorder':
        this.#preorder(this.root, result);
        break;
      case 'postorder':
        this.#postorder(this.root, result);
        break;
      case 'bfs':
        this.#bfs(result);
        break;
    }
    return result;
  }

  /** Shorthand for `traverse('preorder')`. */
  public toArray(): T[] {
    return this.traverse('preorder');
  }

  /** Get the depth of a node (root depth = 0). Returns -1 if not found. */
  public depthOf(node: TreeNode<T>): number {
    if (node === this.root) return 0;
    let depth = 1;
    let current: TreeNode<T> | undefined = this.#findParent(node);
    while (current) {
      if (current === this.root) return depth;
      current = this.#findParent(current);
      depth++;
    }
    return -1;
  }

  /** Number of nodes. */
  public get size(): number {
    return this._size;
  }

  public get isEmpty(): boolean {
    return this._size === 0;
  }

  public get rootNode(): TreeNode<T> | null {
    return this.root;
  }

  // ─── Internal ───

  #preorder(node: TreeNode<T>, result: T[]): void {
    result.push(node.value);
    for (const child of node.children) {
      this.#preorder(child, result);
    }
  }

  #postorder(node: TreeNode<T>, result: T[]): void {
    for (const child of node.children) {
      this.#postorder(child, result);
    }
    result.push(node.value);
  }

  #bfs(result: T[]): void {
    if (!this.root) return;
    const queue: TreeNode<T>[] = [this.root];
    while (queue.length > 0) {
      const node = queue.shift();
      if (!node) continue;
      result.push(node.value);
      for (const child of node.children) {
        queue.push(child);
      }
    }
  }

  #findParent(target: TreeNode<T>): TreeNode<T> | undefined {
    if (!this.root || target === this.root) return undefined;
    const stack: TreeNode<T>[] = [this.root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;
      for (const child of node.children) {
        if (child === target) return node;
        stack.push(child);
      }
    }
  }

  #subtractSize(node: TreeNode<T>): void {
    const stack: TreeNode<T>[] = [node];
    while (stack.length > 0) {
      const n = stack.pop();
      if (!n) continue;
      this._size--;
      for (const child of n.children) {
        stack.push(child);
      }
    }
  }
}
