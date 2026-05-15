import type { BinaryTreeNode, BinaryTreeTraversalOrder } from './interfaces.ts';

/**
 * Generic binary tree base class.
 *
 * Each node has at most two children: `left` and `right`. Provides
 * traversal (preorder, inorder, postorder, BFS, DFS), search, and
 * mutation primitives.
 *
 * This is a general binary tree — not a BST. For a BST, extend this
 * class and enforce ordering in `setLeft`/`setRight`.
 *
 * @example
 * ```ts
 * class ExpressionTree extends BinaryTree<string> {
 *   evaluate(node?: BinaryTreeNode<string>): number {
 *     const n = node ?? this.root;
 *     if (!n) throw new Error('Empty tree');
 *     if (!n.left || !n.right) return Number(n.value);
 *     const l = this.evaluate(n.left);
 *     const r = this.evaluate(n.right);
 *     switch (n.value) {
 *       case '+': return l + r;
 *       case '-': return l - r;
 *       case '*': return l * r;
 *       case '/': return l / r;
 *       default: return Number(n.value);
 *     }
 *   }
 * }
 * ```
 */
export class BinaryTree<T> {
  protected root: BinaryTreeNode<T> | null = null;
  protected _size = 0;

  // ─── Mutation ───

  /** Set the root value. Replaces any existing tree. Returns the new root node. */
  setRoot(value: T): BinaryTreeNode<T> {
    this.root = { value, left: null, right: null };
    this._size = 1;
    return this.root;
  }

  /** Set the left child of `parent`. Returns the new node. */
  setLeft(parent: BinaryTreeNode<T>, value: T): BinaryTreeNode<T> {
    const child: BinaryTreeNode<T> = { value, left: null, right: null };
    if (parent.left) this.#subtractSize(parent.left);
    parent.left = child;
    this._size++;
    return child;
  }

  /** Set the right child of `parent`. Returns the new node. */
  setRight(parent: BinaryTreeNode<T>, value: T): BinaryTreeNode<T> {
    const child: BinaryTreeNode<T> = { value, left: null, right: null };
    if (parent.right) this.#subtractSize(parent.right);
    parent.right = child;
    this._size++;
    return child;
  }

  /**
   * Remove a node and its entire subtree.
   * Returns `true` if the node was found and removed.
   */
  remove(node: BinaryTreeNode<T>): boolean {
    if (this.root === node) {
      this.root = null;
      this._size = 0;
      return true;
    }
    const parent = this.#findParent(node);
    if (!parent) return false;

    const removed = this.#subtractSize(node);
    if (parent.left === node) {
      parent.left = null;
    } else {
      parent.right = null;
    }
    return removed;
  }

  /** Remove all nodes. */
  clear(): void {
    this.root = null;
    this._size = 0;
  }

  // ─── Queries ───

  /**
   * Find the first node whose value satisfies `predicate`.
   * Uses preorder traversal.
   */
  find(predicate: (value: T) => boolean): BinaryTreeNode<T> | undefined {
    if (!this.root) return undefined;
    const stack: BinaryTreeNode<T>[] = [this.root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (predicate(node.value)) return node;
      if (node.right) stack.push(node.right);
      if (node.left) stack.push(node.left);
    }
  }

  /** Traverse the tree and collect values in the specified order. */
  traverse(order: BinaryTreeTraversalOrder): T[] {
    const result: T[] = [];
    if (!this.root) return result;

    switch (order) {
      case 'preorder':
        this.#preorder(this.root, result);
        break;
      case 'inorder':
        this.#inorder(this.root, result);
        break;
      case 'postorder':
        this.#postorder(this.root, result);
        break;
      case 'bfs':
        this.#bfs(result);
        break;
      case 'dfs':
        this.#dfs(result);
        break;
    }
    return result;
  }

  /** Shorthand for `traverse('preorder')`. */
  toArray(): T[] {
    return this.traverse('preorder');
  }

  /** Height of the tree (number of edges on the longest root-to-leaf path). */
  get height(): number {
    return this.#height(this.root);
  }

  /** Number of nodes. */
  get size(): number {
    return this._size;
  }

  get isEmpty(): boolean {
    return this._size === 0;
  }

  get rootNode(): BinaryTreeNode<T> | null {
    return this.root;
  }

  // ─── Internal ───

  #preorder(node: BinaryTreeNode<T>, result: T[]): void {
    result.push(node.value);
    if (node.left) this.#preorder(node.left, result);
    if (node.right) this.#preorder(node.right, result);
  }

  #inorder(node: BinaryTreeNode<T>, result: T[]): void {
    if (node.left) this.#inorder(node.left, result);
    result.push(node.value);
    if (node.right) this.#inorder(node.right, result);
  }

  #postorder(node: BinaryTreeNode<T>, result: T[]): void {
    if (node.left) this.#postorder(node.left, result);
    if (node.right) this.#postorder(node.right, result);
    result.push(node.value);
  }

  #bfs(result: T[]): void {
    if (!this.root) return;
    const queue: BinaryTreeNode<T>[] = [this.root];
    while (queue.length > 0) {
      const node = queue.shift()!;
      result.push(node.value);
      if (node.left) queue.push(node.left);
      if (node.right) queue.push(node.right);
    }
  }

  #dfs(result: T[]): void {
    if (!this.root) return;
    const stack: BinaryTreeNode<T>[] = [this.root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      result.push(node.value);
      if (node.right) stack.push(node.right);
      if (node.left) stack.push(node.left);
    }
  }

  #findParent(target: BinaryTreeNode<T>): BinaryTreeNode<T> | undefined {
    if (!this.root || target === this.root) return undefined;
    const stack: BinaryTreeNode<T>[] = [this.root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.left === target || node.right === target) return node;
      if (node.right) stack.push(node.right);
      if (node.left) stack.push(node.left);
    }
  }

  #subtractSize(node: BinaryTreeNode<T>): boolean {
    const stack: BinaryTreeNode<T>[] = [node];
    while (stack.length > 0) {
      const n = stack.pop()!;
      this._size--;
      if (n.right) stack.push(n.right);
      if (n.left) stack.push(n.left);
    }
    return true;
  }

  #height(node: BinaryTreeNode<T> | null): number {
    if (!node) return -1;
    return 1 + Math.max(this.#height(node.left), this.#height(node.right));
  }
}
