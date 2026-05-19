import { describe, it, expect } from 'vitest';
import { CircularQueue } from '../../../src/core/circular-queue/queue.ts';

// ─── Test helpers ───

/** Expose protected internals for white-box inspection. */
class TestQueue<T> extends CircularQueue<T> {
  inspectBuffer() { return [...this.buffer]; }
  inspectHead() { return this.head; }
  inspectTail() { return this.tail; }
}

// ─── Construction ───

describe('CircularQueue (white-box)', () => {
  describe('constructor', () => {
    it('creates empty fixed-capacity queue', () => {
      const q = new TestQueue<number>({ capacity: 4 });
      expect(q.size).toBe(0);
      expect(q.isEmpty).toBe(true);
      expect(q.isFull).toBe(false);
      expect(q.capacity).toBe(4);
    });

    it('creates empty auto-growing queue when capacity is omitted', () => {
      const q = new TestQueue<number>();
      expect(q.size).toBe(0);
      expect(q.capacity).toBe(16);
    });

    it('handles capacity of 0 as auto-growing', () => {
      const q = new TestQueue<number>({ capacity: 0 });
      expect(q.capacity).toBe(16);
    });
  });

  // ─── Enqueue / Dequeue ───

  describe('enqueue / dequeue', () => {
    it('enqueues and dequeues in FIFO order', () => {
      const q = new TestQueue<number>({ capacity: 4 });
      q.enqueue(1);
      q.enqueue(2);
      q.enqueue(3);
      expect(q.dequeue()).toBe(1);
      expect(q.dequeue()).toBe(2);
      expect(q.dequeue()).toBe(3);
      expect(q.isEmpty).toBe(true);
    });

    it('returns false when fixed-capacity queue is full', () => {
      const q = new TestQueue<number>({ capacity: 2 });
      expect(q.enqueue(1)).toBe(true);
      expect(q.enqueue(2)).toBe(true);
      expect(q.enqueue(3)).toBe(false);
      expect(q.size).toBe(2);
    });

    it('auto-grows when capacity is not fixed', () => {
      const q = new TestQueue<number>({ capacity: 2 });
      // force fixed=false via no capacity — test auto-grow separately
      const grow = new TestQueue<number>();
      expect(grow.capacity).toBe(16);
      for (let i = 0; i < 20; i++) {
        expect(grow.enqueue(i)).toBe(true);
      }
      expect(grow.size).toBe(20);
      expect(grow.capacity).toBeGreaterThanOrEqual(20);
      for (let i = 0; i < 20; i++) {
        expect(grow.dequeue()).toBe(i);
      }
    });

    it('dequeue on empty returns undefined', () => {
      const q = new TestQueue<number>({ capacity: 4 });
      expect(q.dequeue()).toBeUndefined();
    });

    it('wraps indices around the buffer', () => {
      const q = new TestQueue<number>({ capacity: 3 });
      q.enqueue(1);
      q.enqueue(2);
      q.enqueue(3);
      expect(q.dequeue()).toBe(1);
      q.enqueue(4);
      // buffer should now be: [undefined, 2, 3, 4] → logically [2, 3, 4]
      expect(q.toArray()).toEqual([2, 3, 4]);
      expect(q.dequeue()).toBe(2);
      expect(q.dequeue()).toBe(3);
      expect(q.dequeue()).toBe(4);
    });
  });

  // ─── Round-robin rotation ───

  describe('rotate (round-robin)', () => {
    it('moves head to tail and returns new head', () => {
      const q = new TestQueue<number>({ capacity: 4 });
      q.enqueue(1);
      q.enqueue(2);
      q.enqueue(3);
      // before: [1, 2, 3]; rotate → [2, 3, 1]
      expect(q.rotate()).toBe(2);
      expect(q.toArray()).toEqual([2, 3, 1]);
    });

    it('rotate on single element does nothing', () => {
      const q = new TestQueue<number>({ capacity: 4 });
      q.enqueue(42);
      expect(q.rotate()).toBe(42);
      expect(q.toArray()).toEqual([42]);
    });

    it('rotate on empty queue returns undefined', () => {
      const q = new TestQueue<number>({ capacity: 4 });
      expect(q.rotate()).toBeUndefined();
    });

    it('full round-trip returns to original order after N rotates', () => {
      const q = new TestQueue<number>({ capacity: 4 });
      q.enqueue(1);
      q.enqueue(2);
      q.enqueue(3);
      for (let i = 0; i < 3; i++) q.rotate();
      expect(q.toArray()).toEqual([1, 2, 3]);
    });
  });

  // ─── current ───

  describe('current', () => {
    it('returns head element without removing', () => {
      const q = new TestQueue<number>({ capacity: 4 });
      q.enqueue(10);
      q.enqueue(20);
      expect(q.current).toBe(10);
      expect(q.size).toBe(2);
    });

    it('returns undefined on empty queue', () => {
      const q = new TestQueue<number>({ capacity: 4 });
      expect(q.current).toBeUndefined();
    });

    it('updates after rotate', () => {
      const q = new TestQueue<number>({ capacity: 4 });
      q.enqueue(1);
      q.enqueue(2);
      q.enqueue(3);
      expect(q.current).toBe(1);
      q.rotate();
      expect(q.current).toBe(2);
      q.rotate();
      expect(q.current).toBe(3);
    });
  });

  // ─── dequeueTail ───

  describe('dequeueTail', () => {
    it('removes and returns the most recently enqueued element', () => {
      const q = new TestQueue<number>({ capacity: 4 });
      q.enqueue(1);
      q.enqueue(2);
      q.enqueue(3);
      expect(q.dequeueTail()).toBe(3);
      expect(q.toArray()).toEqual([1, 2]);
    });

    it('on single element dequeues it', () => {
      const q = new TestQueue<number>({ capacity: 4 });
      q.enqueue(42);
      expect(q.dequeueTail()).toBe(42);
      expect(q.isEmpty).toBe(true);
    });

    it('on empty returns undefined', () => {
      const q = new TestQueue<number>({ capacity: 4 });
      expect(q.dequeueTail()).toBeUndefined();
    });
  });

  // ─── clear ───

  describe('clear', () => {
    it('removes all elements', () => {
      const q = new TestQueue<number>({ capacity: 4 });
      q.enqueue(1);
      q.enqueue(2);
      q.enqueue(3);
      q.clear();
      expect(q.size).toBe(0);
      expect(q.isEmpty).toBe(true);
      expect(q.toArray()).toEqual([]);
    });
  });

  // ─── at ───

  describe('at', () => {
    it('returns element at logical index', () => {
      const q = new TestQueue<number>({ capacity: 4 });
      q.enqueue(10);
      q.enqueue(20);
      q.enqueue(30);
      expect(q.at(0)).toBe(10);
      expect(q.at(1)).toBe(20);
      expect(q.at(2)).toBe(30);
    });

    it('supports negative indices from tail', () => {
      const q = new TestQueue<number>({ capacity: 4 });
      q.enqueue(10);
      q.enqueue(20);
      q.enqueue(30);
      expect(q.at(-1)).toBe(30);
      expect(q.at(-2)).toBe(20);
      expect(q.at(-3)).toBe(10);
    });

    it('returns undefined for out-of-range', () => {
      const q = new TestQueue<number>({ capacity: 4 });
      q.enqueue(10);
      expect(q.at(5)).toBeUndefined();
      expect(q.at(-5)).toBeUndefined();
    });
  });

  // ─── includes ───

  describe('includes', () => {
    it('returns true when value is present', () => {
      const q = new TestQueue<number>({ capacity: 4 });
      q.enqueue(1);
      q.enqueue(2);
      expect(q.includes(1)).toBe(true);
      expect(q.includes(2)).toBe(true);
    });

    it('returns false when value is absent', () => {
      const q = new TestQueue<number>({ capacity: 4 });
      q.enqueue(1);
      expect(q.includes(99)).toBe(false);
    });

    it('returns false on empty queue', () => {
      const q = new TestQueue<number>({ capacity: 4 });
      expect(q.includes(1)).toBe(false);
    });
  });

  // ─── toArray ───

  describe('toArray', () => {
    it('returns elements head to tail', () => {
      const q = new TestQueue<number>({ capacity: 4 });
      q.enqueue(3);
      q.enqueue(1);
      q.enqueue(2);
      expect(q.toArray()).toEqual([3, 1, 2]);
    });

    it('returns empty array for empty queue', () => {
      const q = new TestQueue<number>({ capacity: 4 });
      expect(q.toArray()).toEqual([]);
    });

    it('preserves order after wrap-around', () => {
      const q = new TestQueue<number>({ capacity: 3 });
      q.enqueue(1);
      q.enqueue(2);
      q.enqueue(3);
      q.dequeue(); // 1 removed, head → 1
      q.enqueue(4); // tail wraps to index 0
      // logical: [2, 3, 4]
      expect(q.toArray()).toEqual([2, 3, 4]);
    });
  });

  // ─── Iteration ───

  describe('iteration', () => {
    it('values() yields head to tail', () => {
      const q = new TestQueue<number>({ capacity: 4 });
      q.enqueue(1);
      q.enqueue(2);
      q.enqueue(3);
      expect([...q.values()]).toEqual([1, 2, 3]);
    });

    it('Symbol.iterator works (for-of)', () => {
      const q = new TestQueue<number>({ capacity: 4 });
      q.enqueue(10);
      q.enqueue(20);
      const result: number[] = [];
      for (const v of q) result.push(v);
      expect(result).toEqual([10, 20]);
    });

    it('entries() yields [index, value] pairs', () => {
      const q = new TestQueue<number>({ capacity: 4 });
      q.enqueue(1);
      q.enqueue(2);
      expect([...q.entries()]).toEqual([[0, 1], [1, 2]]);
    });
  });

  // ─── Properties ───

  describe('size / isEmpty / isFull', () => {
    it('size tracks element count', () => {
      const q = new TestQueue<number>({ capacity: 4 });
      expect(q.size).toBe(0);
      q.enqueue(1);
      expect(q.size).toBe(1);
      q.enqueue(2);
      expect(q.size).toBe(2);
      q.dequeue();
      expect(q.size).toBe(1);
      q.clear();
      expect(q.size).toBe(0);
    });

    it('isFull reflects fixed-capacity saturation', () => {
      const q = new TestQueue<number>({ capacity: 2 });
      expect(q.isFull).toBe(false);
      q.enqueue(1);
      expect(q.isFull).toBe(false);
      q.enqueue(2);
      expect(q.isFull).toBe(true);
    });
  });

  // ─── Inheritance ───

  describe('inheritance (protected member access)', () => {
    it('subclass can inspect internal buffer', () => {
      const q = new TestQueue<number>({ capacity: 3 });
      q.enqueue(1);
      q.enqueue(2);
      const buf = q.inspectBuffer();
      expect(buf[0]).toBe(1);
      expect(buf[1]).toBe(2);
    });

    it('subclass can add round-robin scheduling logic', () => {
      class RRScheduler extends CircularQueue<() => number> {
        readonly quantum: number;
        constructor(tasks: (() => number)[], quantum: number, cap: number) {
          super({ capacity: cap });
          for (const t of tasks) this.enqueue(t);
          this.quantum = quantum;
        }
        tick(): number | undefined {
          const task = this.current;
          if (!task) return undefined;
          const result = task();
          this.rotate();
          return result;
        }
      }
      let a = 0, b = 0;
      const incA = () => ++a;
      const incB = () => ++b;
      const sched = new RRScheduler([incA, incB], 100, 2);
      expect(sched.tick()).toBe(1); // a++
      expect(sched.tick()).toBe(1); // b++
      expect(sched.tick()).toBe(2); // a++
      expect(a).toBe(2);
      expect(b).toBe(1);
    });

    it('subclass can override enqueue with validation', () => {
      class ValidatedQueue extends CircularQueue<number> {
        override enqueue(value: number): boolean {
          if (value <= 0) throw new Error('Must be positive');
          return super.enqueue(value);
        }
      }
      const q = new ValidatedQueue({ capacity: 4 });
      q.enqueue(5);
      expect(() => q.enqueue(0)).toThrow('Must be positive');
      expect(() => q.enqueue(-1)).toThrow('Must be positive');
      expect(q.size).toBe(1);
    });
  });
});
