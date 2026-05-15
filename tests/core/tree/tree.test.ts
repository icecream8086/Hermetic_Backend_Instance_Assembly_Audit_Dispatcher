import { describe, it, expect } from 'vitest';
import { Tree } from '../../../src/core/tree/tree.ts';
import type { TreeNode } from '../../../src/core/tree/interfaces.ts';

// ─── Test helpers ───

class TestTree<T> extends Tree<T> {
  inspectRoot() { return this.root; }
}

/** Build a simple tree:
 *      root
 *     /    \
 *    a      b
 *   / \    /
 *  c   d  e
 */
function buildSampleTree(): Tree<string> {
  const tree = new TestTree<string>();
  const root = tree.setRoot('root');
  const a = tree.addChild(root, 'a');
  const b = tree.addChild(root, 'b');
  tree.addChild(a, 'c');
  tree.addChild(a, 'd');
  tree.addChild(b, 'e');
  return tree;
}

// ─── Tests ───

describe('Tree (white-box)', () => {
  describe('setRoot', () => {
    it('sets root on empty tree', () => {
      const tree = new TestTree<number>();
      const node = tree.setRoot(42);
      expect(node.value).toBe(42);
      expect(node.children).toEqual([]);
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

  describe('addChild', () => {
    it('adds child to root', () => {
      const tree = new TestTree<string>();
      const root = tree.setRoot('root');
      tree.addChild(root, 'child');
      expect(tree.size).toBe(2);
      expect(root.children).toHaveLength(1);
      expect(root.children[0]!.value).toBe('child');
    });

    it('adds multiple children to same parent', () => {
      const tree = new TestTree<string>();
      const root = tree.setRoot('root');
      tree.addChild(root, 'a');
      tree.addChild(root, 'b');
      expect(root.children).toHaveLength(2);
    });

    it('returns the new child node', () => {
      const tree = new TestTree<string>();
      const root = tree.setRoot('root');
      const child = tree.addChild(root, 'c');
      expect(child.value).toBe('c');
      expect(child.children).toEqual([]);
    });
  });

  describe('remove', () => {
    it('removes a leaf node', () => {
      const tree = buildSampleTree();
      const leaf = tree.find(v => v === 'e')!;
      expect(tree.remove(leaf)).toBe(true);
      expect(tree.size).toBe(5);
      expect(tree.find(v => v === 'e')).toBeUndefined();
    });

    it('removes a subtree', () => {
      const tree = buildSampleTree();
      const subtree = tree.find(v => v === 'a')!;
      expect(tree.remove(subtree)).toBe(true);
      expect(tree.size).toBe(3); // root, b, e
      expect(tree.find(v => v === 'c')).toBeUndefined();
      expect(tree.find(v => v === 'd')).toBeUndefined();
    });

    it('removes root and clears tree', () => {
      const tree = buildSampleTree();
      const root = tree.rootNode!;
      expect(tree.remove(root)).toBe(true);
      expect(tree.size).toBe(0);
      expect(tree.isEmpty).toBe(true);
    });

    it('returns false for node not in tree', () => {
      const tree = new TestTree<number>();
      const orphan: TreeNode<number> = { value: 99, children: [] };
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
      const node = tree.find(v => v === 'c');
      expect(node?.value).toBe('c');
    });

    it('returns undefined for missing value', () => {
      const tree = buildSampleTree();
      expect(tree.find(v => v === 'z')).toBeUndefined();
    });

    it('returns undefined on empty tree', () => {
      const tree = new TestTree<number>();
      expect(tree.find(() => true)).toBeUndefined();
    });

    it('finds root first', () => {
      const tree = buildSampleTree();
      const node = tree.find(v => v.startsWith('r'));
      expect(node?.value).toBe('root');
    });
  });

  describe('traverse', () => {
    it('preorder: root → a → c → d → b → e', () => {
      const tree = buildSampleTree();
      expect(tree.traverse('preorder')).toEqual(['root', 'a', 'c', 'd', 'b', 'e']);
    });

    it('postorder: c → d → a → e → b → root', () => {
      const tree = buildSampleTree();
      expect(tree.traverse('postorder')).toEqual(['c', 'd', 'a', 'e', 'b', 'root']);
    });

    it('bfs: root → a → b → c → d → e', () => {
      const tree = buildSampleTree();
      expect(tree.traverse('bfs')).toEqual(['root', 'a', 'b', 'c', 'd', 'e']);
    });

    it('empty tree returns empty array', () => {
      const tree = new TestTree<number>();
      expect(tree.traverse('preorder')).toEqual([]);
      expect(tree.traverse('postorder')).toEqual([]);
      expect(tree.traverse('bfs')).toEqual([]);
    });

    it('single node tree', () => {
      const tree = new TestTree<string>();
      tree.setRoot('only');
      expect(tree.traverse('preorder')).toEqual(['only']);
      expect(tree.traverse('postorder')).toEqual(['only']);
      expect(tree.traverse('bfs')).toEqual(['only']);
    });
  });

  describe('toArray', () => {
    it('returns preorder traversal', () => {
      const tree = buildSampleTree();
      expect(tree.toArray()).toEqual(tree.traverse('preorder'));
    });
  });

  describe('depthOf', () => {
    it('root depth is 0', () => {
      const tree = buildSampleTree();
      expect(tree.depthOf(tree.rootNode!)).toBe(0);
    });

    it('children of root have depth 1', () => {
      const tree = buildSampleTree();
      const a = tree.find(v => v === 'a')!;
      expect(tree.depthOf(a)).toBe(1);
    });

    it('leaf has correct depth', () => {
      const tree = buildSampleTree();
      const e = tree.find(v => v === 'e')!;
      expect(tree.depthOf(e)).toBe(2);
    });

    it('returns -1 for node not in tree', () => {
      const tree = buildSampleTree();
      const orphan: TreeNode<number> = { value: 99, children: [] };
      expect(tree.depthOf(orphan as unknown as TreeNode<string>)).toBe(-1);
    });
  });

  // ─── Inheritance ───

  describe('inheritance', () => {
    it('subclass can override setRoot with custom behavior', () => {
      class NonEmptyTree extends Tree<string> {
        override setRoot(value: string) {
          if (value.length === 0) throw new Error('Root must not be empty');
          return super.setRoot(value);
        }
      }
      const tree = new NonEmptyTree();
      expect(() => tree.setRoot('')).toThrow('Root must not be empty');
      tree.setRoot('valid');
      expect(tree.rootNode?.value).toBe('valid');
    });

    it('subclass can add domain-specific methods', () => {
      class MaxDepthTree<T> extends Tree<T> {
        maxDepth(): number {
          if (!this.root) return 0;
          return this.#depth(this.root);
        }
        #depth(node: TreeNode<T>): number {
          if (node.children.length === 0) return 1;
          return 1 + Math.max(...node.children.map(c => this.#depth(c)));
        }
      }
      const tree = new MaxDepthTree<string>();
      const root = tree.setRoot('r');
      tree.addChild(root, 'a');
      tree.addChild(root, 'b');
      const a = tree.find(v => v === 'a')!;
      tree.addChild(a, 'c');
      expect(tree.maxDepth()).toBe(3);
    });

    it('subclass can access root directly', () => {
      class RootInspector<T> extends Tree<T> {
        getRootValue(): T | undefined {
          return this.root?.value;
        }
      }
      const tree = new RootInspector<string>();
      tree.setRoot('hello');
      expect(tree.getRootValue()).toBe('hello');
    });
  });
});
