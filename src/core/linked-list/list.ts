import type { ListNode } from './interfaces.ts';

/**
 * Generic doubly-linked list base class.
 *
 * Maintains `head`, `tail`, and `_size`. Subclasses have `protected` access
 * to internals and can override mutation methods to add validation or
 * side-effects.
 *
 * @example
 * ```ts
 * class NumberList extends LinkedList<number> {
 *   addPositive(n: number): ListNode<number> {
 *     if (n <= 0) throw new Error('Only positive numbers allowed');
 *     return this.addToTail(n);
 *   }
 * }
 * ```
 */
export class LinkedList<T> {
  protected head: ListNode<T> | null = null;
  protected tail: ListNode<T> | null = null;
  protected _size = 0;

  // ─── Mutation ───

  /** Insert a value at the head of the list. Returns the new node. */
  public addToHead(value: T): ListNode<T> {
    const node: ListNode<T> = { value, next: null, prev: null };
    if (this.head === null) {
      this.head = node;
      this.tail = node;
    } else {
      node.next = this.head;
      this.head.prev = node;
      this.head = node;
    }
    this._size++;
    return node;
  }

  /** Insert a value at the tail of the list. Returns the new node. */
  public addToTail(value: T): ListNode<T> {
    const node: ListNode<T> = { value, next: null, prev: null };
    if (this.tail === null) {
      this.head = node;
      this.tail = node;
    } else {
      node.prev = this.tail;
      this.tail.next = node;
      this.tail = node;
    }
    this._size++;
    return node;
  }

  /** Insert a value after a given node. Returns the new node. */
  public addAfter(ref: ListNode<T>, value: T): ListNode<T> {
    const node: ListNode<T> = { value, next: ref.next, prev: ref };
    if (ref.next) {
      ref.next.prev = node;
    } else {
      this.tail = node;
    }
    ref.next = node;
    this._size++;
    return node;
  }

  /** Insert a value before a given node. Returns the new node. */
  public addBefore(ref: ListNode<T>, value: T): ListNode<T> {
    const node: ListNode<T> = { value, next: ref, prev: ref.prev };
    if (ref.prev) {
      ref.prev.next = node;
    } else {
      this.head = node;
    }
    ref.prev = node;
    this._size++;
    return node;
  }

  /**
   * Remove a specific node from the list.
   * The caller must ensure the node belongs to this list.
   */
  public remove(node: ListNode<T>): void {
    if (this._size === 0) return;
    if (node.prev) {
      node.prev.next = node.next;
    } else {
      this.head = node.next;
    }
    if (node.next) {
      node.next.prev = node.prev;
    } else {
      this.tail = node.prev;
    }
    this._size--;
  }

  /** Remove and return the value at the head (or undefined if empty). */
  public removeFirst(): T | undefined {
    if (this.head === null) return undefined;
    const value = this.head.value;
    this.remove(this.head);
    return value;
  }

  /** Remove and return the value at the tail (or undefined if empty). */
  public removeLast(): T | undefined {
    if (this.tail === null) return undefined;
    const value = this.tail.value;
    this.remove(this.tail);
    return value;
  }

  /** Remove all nodes. */
  public clear(): void {
    this.head = null;
    this.tail = null;
    this._size = 0;
  }

  // ─── Queries ───

  /**
   * Find the first node whose value satisfies `predicate`.
   * Traverses from head to tail.
   */
  public find(predicate: (value: T) => boolean): ListNode<T> | undefined {
    let current = this.head;
    while (current) {
      if (predicate(current.value)) return current;
      current = current.next;
    }
  }

  /**
   * Find the last node whose value satisfies `predicate`.
   * Traverses from tail to head.
   */
  public findLast(predicate: (value: T) => boolean): ListNode<T> | undefined {
    let current = this.tail;
    while (current) {
      if (predicate(current.value)) return current;
      current = current.prev;
    }
  }

  /** Get the node at `index` (0-based, negative allowed as offset from tail). */
  public at(index: number): ListNode<T> | undefined {
    if (index < 0) return this.#atReverse(-index - 1);
    let current = this.head;
    let i = 0;
    while (current) {
      if (i === index) return current;
      current = current.next;
      i++;
    }
  }

  #atReverse(revIndex: number): ListNode<T> | undefined {
    let current = this.tail;
    let i = 0;
    while (current) {
      if (i === revIndex) return current;
      current = current.prev;
      i++;
    }
  }

  /** Convert the list to an array (head → tail). */
  public toArray(): T[] {
    const result: T[] = [];
    let current = this.head;
    while (current) {
      result.push(current.value);
      current = current.next;
    }
    return result;
  }

  /** Convert the list to an array in reverse (tail → head). */
  public toArrayReverse(): T[] {
    const result: T[] = [];
    let current = this.tail;
    while (current) {
      result.push(current.value);
      current = current.prev;
    }
    return result;
  }

  // ─── Iteration ───

  public *values(): IterableIterator<T> {
    let current = this.head;
    while (current) {
      yield current.value;
      current = current.next;
    }
  }

  public *nodes(): IterableIterator<ListNode<T>> {
    let current = this.head;
    while (current) {
      yield current;
      current = current.next;
    }
  }

  public [Symbol.iterator](): IterableIterator<T> {
    return this.values();
  }

  // ─── Properties ───

  public get size(): number {
    return this._size;
  }

  public get isEmpty(): boolean {
    return this._size === 0;
  }

  public get headNode(): ListNode<T> | null {
    return this.head;
  }

  public get tailNode(): ListNode<T> | null {
    return this.tail;
  }
}
