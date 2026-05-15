import { describe, it, expect } from 'vitest';
import { BinaryTree } from '../../../src/core/tree/binary-tree.ts';
import type { BinaryTreeNode } from '../../../src/core/tree/interfaces.ts';

// ─── Test helpers ───

class TestTree<T> extends BinaryTree<T> {
  inspectRoot() { return this.root; }
}

/** Build a balanced binary tree:
 *        1
 *       / \
 *      2   3
 *     / \   \
 *    4   5   6
 */
function buildSampleTree(): BinaryTree<number> {
  const tree = new TestTree<number>();
  const n1 = tree.setRoot(1);
  const n2 = tree.setLeft(n1, 2);
  const n3 = tree.setRight(n1, 3);
  tree.setLeft(n2, 4);
  tree.setRight(n2, 5);
  tree.setRight(n3, 6);
  return tree;
}

// ─── Tests ───

describe('BinaryTree (white-box)', () => {
  describe('setRoot', () => {
    it('sets root on empty tree', () => {
      const tree = new TestTree<number>();
      const node = tree.setRoot(42);
      expect(node.value).toBe(42);
      expect(node.left).toBeNull();
      expect(node.right).toBeNull();
      expect(tree.size).toBe(1);
      expect(tree.isEmpty).toBe(false);
    });

    it('replaces existing root', () => {
      const tree = new TestTree<number>();
      tree.setRoot(1);
      tree.setRoot(2);
      expect(tree.size).toBe(1);
      expect(tree.rootNode?.value).toBe(2);
    });
  });

  describe('setLeft / setRight', () => {
    it('setLeft adds left child', () => {
      const tree = new TestTree<string>();
      const root = tree.setRoot('r');
      tree.setLeft(root, 'L');
      expect(root.left?.value).toBe('L');
      expect(root.right).toBeNull();
      expect(tree.size).toBe(2);
    });

    it('setRight adds right child', () => {
      const tree = new TestTree<string>();
      const root = tree.setRoot('r');
      tree.setRight(root, 'R');
      expect(root.right?.value).toBe('R');
      expect(root.left).toBeNull();
      expect(tree.size).toBe(2);
    });

    it('overwrites existing child', () => {
      const tree = new TestTree<string>();
      const root = tree.setRoot('r');
      tree.setLeft(root, 'L1');
      tree.setLeft(root, 'L2');
      expect(root.left?.value).toBe('L2');
      expect(tree.size).toBe(2); // old child is orphaned
    });
  });

  describe('remove', () => {
    it('removes a leaf', () => {
      const tree = buildSampleTree();
      const leaf = tree.find(v => v === 4)!;
      expect(tree.remove(leaf)).toBe(true);
      expect(tree.size).toBe(5);
      expect(tree.find(v => v === 4)).toBeUndefined();
    });

    it('removes subtree', () => {
      const tree = buildSampleTree();
      const node2 = tree.find(v => v === 2)!;
      expect(tree.remove(node2)).toBe(true);
      expect(tree.size).toBe(3); // 1, 3, 6
      expect(tree.find(v => v === 4)).toBeUndefined();
      expect(tree.find(v => v === 5)).toBeUndefined();
    });

    it('removes root and clears tree', () => {
      const tree = buildSampleTree();
      expect(tree.remove(tree.rootNode!)).toBe(true);
      expect(tree.size).toBe(0);
      expect(tree.isEmpty).toBe(true);
    });

    it('returns false for node not in tree', () => {
      const tree = new TestTree<number>();
      const orphan: BinaryTreeNode<number> = { value: 99, left: null, right: null };
      expect(tree.remove(orphan)).toBe(false);
    });
  });

  describe('clear', () => {
    it('removes all nodes', () => {
      const tree = buildSampleTree();
      tree.clear();
      expect(tree.size).toBe(0);
      expect(tree.isEmpty).toBe(true);
      expect(tree.rootNode).toBeNull();
    });
  });

  describe('find', () => {
    it('finds node by value', () => {
      const tree = buildSampleTree();
      expect(tree.find(v => v === 5)?.value).toBe(5);
    });

    it('returns undefined for missing value', () => {
      const tree = buildSampleTree();
      expect(tree.find(v => v === 99)).toBeUndefined();
    });

    it('returns undefined on empty tree', () => {
      const tree = new TestTree<number>();
      expect(tree.find(() => true)).toBeUndefined();
    });
  });

  describe('traverse', () => {
    it('preorder: 1 → 2 → 4 → 5 → 3 → 6', () => {
      const tree = buildSampleTree();
      expect(tree.traverse('preorder')).toEqual([1, 2, 4, 5, 3, 6]);
    });

    it('inorder: 4 → 2 → 5 → 1 → 3 → 6', () => {
      const tree = buildSampleTree();
      expect(tree.traverse('inorder')).toEqual([4, 2, 5, 1, 3, 6]);
    });

    it('postorder: 4 → 5 → 2 → 6 → 3 → 1', () => {
      const tree = buildSampleTree();
      expect(tree.traverse('postorder')).toEqual([4, 5, 2, 6, 3, 1]);
    });

    it('bfs: 1 → 2 → 3 → 4 → 5 → 6', () => {
      const tree = buildSampleTree();
      expect(tree.traverse('bfs')).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('dfs: 1 → 2 → 4 → 5 → 3 → 6 (preorder stack)', () => {
      const tree = buildSampleTree();
      expect(tree.traverse('dfs')).toEqual([1, 2, 4, 5, 3, 6]);
    });

    it('empty tree returns empty array', () => {
      const tree = new TestTree<number>();
      for (const order of ['preorder', 'inorder', 'postorder', 'bfs', 'dfs'] as const) {
        expect(tree.traverse(order)).toEqual([]);
      }
    });

    it('single node tree', () => {
      const tree = new TestTree<string>();
      tree.setRoot('only');
      for (const order of ['preorder', 'inorder', 'postorder', 'bfs', 'dfs'] as const) {
        expect(tree.traverse(order)).toEqual(['only']);
      }
    });

    it('left-skewed tree: 1 → 2 → 3 (all left children)', () => {
      const tree = new TestTree<number>();
      const n1 = tree.setRoot(1);
      const n2 = tree.setLeft(n1, 2);
      tree.setLeft(n2, 3);
      expect(tree.traverse('preorder')).toEqual([1, 2, 3]);
      expect(tree.traverse('inorder')).toEqual([3, 2, 1]);
      expect(tree.traverse('postorder')).toEqual([3, 2, 1]);
    });
  });

  describe('toArray', () => {
    it('returns preorder traversal', () => {
      const tree = buildSampleTree();
      expect(tree.toArray()).toEqual(tree.traverse('preorder'));
    });
  });

  describe('height', () => {
    it('single node tree has height 0', () => {
      const tree = new TestTree<number>();
      tree.setRoot(1);
      expect(tree.height).toBe(0);
    });

    it('balanced tree has correct height', () => {
      const tree = buildSampleTree();
      expect(tree.height).toBe(2); // edges: 1→2→4
    });

    it('empty tree has height -1', () => {
      const tree = new TestTree<number>();
      expect(tree.height).toBe(-1);
    });

    it('left-skewed tree height equals size-1', () => {
      const tree = new TestTree<number>();
      const n1 = tree.setRoot(1);
      const n2 = tree.setLeft(n1, 2);
      tree.setLeft(n2, 3);
      expect(tree.height).toBe(2);
    });
  });

  // ─── Inheritance ───

  describe('inheritance', () => {
    it('subclass can override setLeft with validation', () => {
      class NoNegativeTree extends BinaryTree<number> {
        override setLeft(parent: BinaryTreeNode<number>, value: number) {
          if (value < 0) throw new Error('Negative values not allowed');
          return super.setLeft(parent, value);
        }
      }
      const tree = new NoNegativeTree();
      const root = tree.setRoot(0);
      expect(() => tree.setLeft(root, -1)).toThrow('Negative values not allowed');
      tree.setLeft(root, 1);
      expect(root.left?.value).toBe(1);
    });

    it('subclass can add domain-specific methods', () => {
      class SumTree extends BinaryTree<number> {
        sum(): number {
          let total = 0;
          this.traverse('preorder').forEach(v => { total += v; });
          return total;
        }
      }
      const tree = new SumTree();
      const n1 = tree.setRoot(10);
      const n2 = tree.setLeft(n1, 20);
      tree.setRight(n1, 30);
      tree.setLeft(n2, 40);
      expect(tree.sum()).toBe(100);
    });

    it('subclass can access root directly', () => {
      class RootInspector<T> extends BinaryTree<T> {
        getRootValue(): T | undefined {
          return this.root?.value;
        }
      }
      const tree = new RootInspector<string>();
      tree.setRoot('hello');
      expect(tree.getRootValue()).toBe('hello');
    });

    it('subclass can implement a BST', () => {
      class BST extends BinaryTree<number> {
        insert(value: number): void {
          const newNode: BinaryTreeNode<number> = { value, left: null, right: null };
          if (!this.root) {
            this.root = newNode;
            this._size = 1;
            return;
          }
          let current = this.root;
          while (true) {
            if (value < current.value) {
              if (!current.left) { current.left = newNode; this._size++; return; }
              current = current.left;
            } else {
              if (!current.right) { current.right = newNode; this._size++; return; }
              current = current.right;
            }
          }
        }
      }
      const bst = new BST();
      bst.insert(5);
      bst.insert(3);
      bst.insert(7);
      bst.insert(1);
      expect(bst.size).toBe(4);
      expect(bst.traverse('inorder')).toEqual([1, 3, 5, 7]);
    });
  });
});
