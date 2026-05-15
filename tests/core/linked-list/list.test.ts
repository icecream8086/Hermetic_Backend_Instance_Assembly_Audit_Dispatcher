import { describe, it, expect } from 'vitest';
import { LinkedList } from '../../../src/core/linked-list/list.ts';

// ─── Test helpers ───

/** Expose protected internals for white-box inspection. */
class TestList<T> extends LinkedList<T> {
  inspectHead(): T | undefined { return this.head?.value; }
  inspectTail(): T | undefined { return this.tail?.value; }
  inspectHeadNode() { return this.head; }
  inspectTailNode() { return this.tail; }
}

// ─── Construction & mutation ───

describe('LinkedList (white-box)', () => {
  describe('addToHead', () => {
    it('adds to empty list', () => {
      const list = new TestList<number>();
      list.addToHead(1);
      expect(list.size).toBe(1);
      expect(list.inspectHead()).toBe(1);
      expect(list.inspectTail()).toBe(1);
    });

    it('prepends to non-empty list', () => {
      const list = new TestList<number>();
      list.addToHead(2);
      list.addToHead(1);
      expect(list.toArray()).toEqual([1, 2]);
      expect(list.inspectHead()).toBe(1);
      expect(list.inspectTail()).toBe(2);
    });

    it('returns the new node', () => {
      const list = new TestList<number>();
      const node = list.addToHead(42);
      expect(node.value).toBe(42);
      expect(node.next).toBeNull();
      expect(node.prev).toBeNull();
    });
  });

  describe('addToTail', () => {
    it('adds to empty list', () => {
      const list = new TestList<number>();
      list.addToTail(1);
      expect(list.size).toBe(1);
      expect(list.toArray()).toEqual([1]);
    });

    it('appends to non-empty list', () => {
      const list = new TestList<number>();
      list.addToTail(1);
      list.addToTail(2);
      expect(list.toArray()).toEqual([1, 2]);
    });

    it('returns the new node', () => {
      const list = new TestList<number>();
      const node = list.addToTail(99);
      expect(node.value).toBe(99);
      expect(node.next).toBeNull();
      expect(node.prev).toBeNull();
    });
  });

  describe('addAfter / addBefore', () => {
    it('addAfter inserts between nodes', () => {
      const list = new TestList<number>();
      const a = list.addToTail(1);
      const c = list.addToTail(3);
      list.addAfter(a, 2);
      expect(list.toArray()).toEqual([1, 2, 3]);
    });

    it('addAfter at tail updates tail pointer', () => {
      const list = new TestList<number>();
      const a = list.addToTail(1);
      const b = list.addAfter(a, 2);
      expect(list.inspectTail()).toBe(2);
      expect(list.tailNode).toBe(b);
    });

    it('addBefore inserts between nodes', () => {
      const list = new TestList<number>();
      const a = list.addToTail(1);
      const c = list.addToTail(3);
      list.addBefore(c, 2);
      expect(list.toArray()).toEqual([1, 2, 3]);
    });

    it('addBefore at head updates head pointer', () => {
      const list = new TestList<number>();
      const b = list.addToTail(2);
      const a = list.addBefore(b, 1);
      expect(list.inspectHead()).toBe(1);
      expect(list.headNode).toBe(a);
    });

    it('addAfter on single node works', () => {
      const list = new TestList<number>();
      const a = list.addToTail(1);
      list.addAfter(a, 2);
      expect(list.toArray()).toEqual([1, 2]);
    });
  });

  describe('remove', () => {
    it('removes head node', () => {
      const list = new TestList<number>();
      const a = list.addToTail(1);
      list.addToTail(2);
      list.remove(a);
      expect(list.toArray()).toEqual([2]);
      expect(list.size).toBe(1);
    });

    it('removes tail node', () => {
      const list = new TestList<number>();
      list.addToTail(1);
      const b = list.addToTail(2);
      list.remove(b);
      expect(list.toArray()).toEqual([1]);
      expect(list.inspectTail()).toBe(1);
    });

    it('removes middle node', () => {
      const list = new TestList<number>();
      list.addToTail(1);
      const b = list.addToTail(2);
      list.addToTail(3);
      list.remove(b);
      expect(list.toArray()).toEqual([1, 3]);
    });

    it('removes the only node', () => {
      const list = new TestList<number>();
      const a = list.addToTail(1);
      list.remove(a);
      expect(list.toArray()).toEqual([]);
      expect(list.size).toBe(0);
      expect(list.headNode).toBeNull();
      expect(list.tailNode).toBeNull();
    });
  });

  describe('removeFirst / removeLast', () => {
    it('removeFirst returns and removes head', () => {
      const list = new TestList<number>();
      list.addToTail(1);
      list.addToTail(2);
      expect(list.removeFirst()).toBe(1);
      expect(list.toArray()).toEqual([2]);
    });

    it('removeLast returns and removes tail', () => {
      const list = new TestList<number>();
      list.addToTail(1);
      list.addToTail(2);
      expect(list.removeLast()).toBe(2);
      expect(list.toArray()).toEqual([1]);
    });

    it('removeFirst on empty returns undefined', () => {
      const list = new TestList<number>();
      expect(list.removeFirst()).toBeUndefined();
    });

    it('removeLast on empty returns undefined', () => {
      const list = new TestList<number>();
      expect(list.removeLast()).toBeUndefined();
    });

    it('removeFirst on single node leaves empty list', () => {
      const list = new TestList<number>();
      list.addToTail(1);
      list.removeFirst();
      expect(list.isEmpty).toBe(true);
    });
  });

  describe('clear', () => {
    it('removes all nodes', () => {
      const list = new TestList<number>();
      list.addToTail(1);
      list.addToTail(2);
      list.addToTail(3);
      list.clear();
      expect(list.size).toBe(0);
      expect(list.isEmpty).toBe(true);
      expect(list.toArray()).toEqual([]);
      expect(list.headNode).toBeNull();
      expect(list.tailNode).toBeNull();
    });
  });

  describe('queries', () => {
    it('find returns first matching node', () => {
      const list = new TestList<number>();
      list.addToTail(1);
      list.addToTail(2);
      list.addToTail(3);
      const node = list.find(v => v > 1);
      expect(node?.value).toBe(2);
    });

    it('find returns undefined when no match', () => {
      const list = new TestList<number>();
      list.addToTail(1);
      expect(list.find(v => v > 10)).toBeUndefined();
    });

    it('find on empty list returns undefined', () => {
      const list = new TestList<number>();
      expect(list.find(() => true)).toBeUndefined();
    });

    it('findLast returns last matching node', () => {
      const list = new TestList<number>();
      list.addToTail(1);
      list.addToTail(2);
      list.addToTail(2);
      list.addToTail(3);
      const node = list.findLast(v => v === 2);
      // should be the second 2
      expect(node?.value).toBe(2);
      expect(node?.next?.value).toBe(3);
    });

    it('findLast from tail works', () => {
      const list = new TestList<number>();
      list.addToTail(1);
      list.addToTail(2);
      expect(list.findLast(v => v === 1)?.value).toBe(1);
    });

    it('at returns node at positive index', () => {
      const list = new TestList<number>();
      list.addToTail('a');
      list.addToTail('b');
      list.addToTail('c');
      expect(list.at(0)?.value).toBe('a');
      expect(list.at(1)?.value).toBe('b');
      expect(list.at(2)?.value).toBe('c');
    });

    it('at returns undefined for out-of-range positive index', () => {
      const list = new TestList<number>();
      list.addToTail(1);
      expect(list.at(5)).toBeUndefined();
    });

    it('at with negative index counts from tail', () => {
      const list = new TestList<number>();
      list.addToTail('a');
      list.addToTail('b');
      list.addToTail('c');
      expect(list.at(-1)?.value).toBe('c');
      expect(list.at(-2)?.value).toBe('b');
      expect(list.at(-3)?.value).toBe('a');
    });

    it('at with negative index beyond list returns undefined', () => {
      const list = new TestList<number>();
      list.addToTail(1);
      expect(list.at(-5)).toBeUndefined();
    });
  });

  describe('toArray / toArrayReverse', () => {
    it('toArray returns values head to tail', () => {
      const list = new TestList<number>();
      list.addToTail(1);
      list.addToTail(2);
      list.addToTail(3);
      expect(list.toArray()).toEqual([1, 2, 3]);
    });

    it('toArray on empty returns []', () => {
      const list = new TestList<number>();
      expect(list.toArray()).toEqual([]);
    });

    it('toArrayReverse returns values tail to head', () => {
      const list = new TestList<number>();
      list.addToTail(1);
      list.addToTail(2);
      list.addToTail(3);
      expect(list.toArrayReverse()).toEqual([3, 2, 1]);
    });
  });

  describe('iteration', () => {
    it('values() yields head to tail', () => {
      const list = new TestList<number>();
      list.addToTail(1);
      list.addToTail(2);
      expect([...list.values()]).toEqual([1, 2]);
    });

    it('Symbol.iterator works (for-of)', () => {
      const list = new TestList<number>();
      list.addToTail(10);
      list.addToTail(20);
      const result: number[] = [];
      for (const v of list) result.push(v);
      expect(result).toEqual([10, 20]);
    });

    it('nodes() yields node references', () => {
      const list = new TestList<number>();
      list.addToTail(1);
      list.addToTail(2);
      const nodes = [...list.nodes()];
      expect(nodes).toHaveLength(2);
      expect(nodes[0]!.value).toBe(1);
      expect(nodes[1]!.value).toBe(2);
      // nodes are linked
      expect(nodes[0]!.next).toBe(nodes[1]);
      expect(nodes[1]!.prev).toBe(nodes[0]);
    });
  });

  describe('size / isEmpty', () => {
    it('isEmpty returns true for new list', () => {
      const list = new TestList<number>();
      expect(list.isEmpty).toBe(true);
    });

    it('size tracks number of nodes', () => {
      const list = new TestList<number>();
      expect(list.size).toBe(0);
      list.addToTail(1);
      expect(list.size).toBe(1);
      list.addToHead(0);
      expect(list.size).toBe(2);
      list.removeFirst();
      expect(list.size).toBe(1);
      list.clear();
      expect(list.size).toBe(0);
    });
  });

  describe('pointer integrity (doubly-link invariants)', () => {
    it('prev pointers form a correct reverse chain', () => {
      const list = new TestList<number>();
      const nodes = [list.addToTail(1), list.addToTail(2), list.addToTail(3)];
      expect(nodes[0]!.prev).toBeNull();
      expect(nodes[1]!.prev).toBe(nodes[0]);
      expect(nodes[2]!.prev).toBe(nodes[1]);
    });

    it('next pointers form a correct forward chain', () => {
      const list = new TestList<number>();
      const nodes = [list.addToTail(1), list.addToTail(2), list.addToTail(3)];
      expect(nodes[0]!.next).toBe(nodes[1]);
      expect(nodes[1]!.next).toBe(nodes[2]);
      expect(nodes[2]!.next).toBeNull();
    });

    it('invariants preserved after remove from middle', () => {
      const list = new TestList<number>();
      const a = list.addToTail(1);
      const b = list.addToTail(2);
      const c = list.addToTail(3);
      list.remove(b);
      expect(a.next).toBe(c);
      expect(c.prev).toBe(a);
    });
  });

  // ─── Inheritance ───

  describe('inheritance (protected member access)', () => {
    it('subclass can inspect head/tail via exposed getters', () => {
      const list = new TestList<number>();
      list.addToTail(42);
      expect(list.inspectHead()).toBe(42);
      expect(list.inspectTail()).toBe(42);
    });

    it('subclass can override addToTail with custom behaviour', () => {
      class PositiveList extends LinkedList<number> {
        addToTail(value: number) {
          if (value <= 0) throw new Error('Only positive numbers');
          return super.addToTail(value);
        }
      }
      const list = new PositiveList();
      list.addToTail(1);
      expect(() => list.addToTail(-1)).toThrow('Only positive numbers');
      expect(list.size).toBe(1);
    });

    it('subclass can add domain-specific methods', () => {
      class SumList extends LinkedList<number> {
        sum(): number {
          let total = 0;
          let current = this.head;
          while (current) {
            total += current.value;
            current = current.next;
          }
          return total;
        }
      }
      const list = new SumList();
      list.addToTail(10);
      list.addToTail(20);
      list.addToTail(30);
      expect(list.sum()).toBe(60);
    });
  });
});
