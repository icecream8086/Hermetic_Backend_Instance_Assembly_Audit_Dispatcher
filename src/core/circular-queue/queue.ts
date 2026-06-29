import type { CircularQueueOptions } from './interfaces.ts';

/**
 * Generic circular queue (ring buffer) base class with round-robin rotation.
 *
 * Supports two modes:
 * - **Fixed capacity** — `enqueue` returns `false` when full. Ideal for
 *   deterministic scheduling with a known maximum number of slots.
 * - **Auto-growing** (`capacity` omitted / 0) — starts at 16 and doubles
 *   when full. Indices still wrap around internally.
 *
 * The `rotate()` method moves the current head element to the tail,
 * implementing the core time-slice round-robin (RR) scheduling primitive.
 *
 * @example
 * ```ts
 * // Time-slice round-robin scheduler
 * class TimeSliceQueue extends CircularQueue<() => Promise<void>> {
 *   readonly quantumMs: number;
 *
 *   constructor(tasks: (() => Promise<void>)[], quantumMs: number) {
 *     super({ capacity: tasks.length });
 *     for (const t of tasks) this.enqueue(t);
 *     this.quantumMs = quantumMs;
 *   }
 *
 *   async tick(): Promise<void> {
 *     const task = this.current;
 *     if (task) await task();
 *     this.rotate();
 *   }
 * }
 * ```
 */
export class CircularQueue<T> {
  protected buffer: (T | undefined)[];
  protected _capacity: number;
  protected _size = 0;
  protected head = 0;
  protected tail = 0;
  protected readonly fixed: boolean;

  public constructor(options?: CircularQueueOptions) {
    const cap = options?.capacity ?? 0;
    this.fixed = cap > 0;
    this._capacity = this.fixed ? cap : 16;
    this.buffer = new Array(this._capacity);
  }

  // ─── Standard queue mutation ───

  /**
   * Insert a value at the tail of the queue.
   * @returns `false` if the queue has a fixed capacity and is full.
   */
  public enqueue(value: T): boolean {
    if (this._size === this._capacity) {
      if (this.fixed) return false;
      this.#resize();
    }
    this.buffer[this.tail] = value;
    this.tail = (this.tail + 1) % this._capacity;
    this._size++;
    return true;
  }

  /**
   * Remove and return the value at the head (the oldest element).
   * Returns `undefined` if the queue is empty.
   */
  public dequeue(): T | undefined {
    if (this._size === 0) return undefined;
    const value = this.buffer[this.head];
    this.buffer[this.head] = undefined;
    this.head = (this.head + 1) % this._capacity;
    this._size--;
    return value;
  }

  /**
   * Return the value at the head without removing it.
   * Returns `undefined` if the queue is empty.
   */
  public peek(): T | undefined {
    return this.buffer[this.head];
  }

  /**
   * Current element in a round-robin scheduling context.
   * Alias for {@link peek}.
   */
  public get current(): T | undefined {
    return this.peek();
  }

  /**
   * Round-robin rotation: move the current head element to the tail
   * and advance the head to the next element.
   *
   * This is the central primitive for time-slice round-robin scheduling:
   * after a task's time quantum expires, call `rotate()` to yield the CPU
   * to the next ready task.
   *
   * @returns The new head (the "current" for the next time slice), or
   *   `undefined` if the queue is empty.
   */
  public rotate(): T | undefined {
    if (this._size <= 1) return this.peek();
    const value = this.dequeue()!;
    this.enqueue(value);
    return this.buffer[this.head];
  }

  /**
   * Remove and return the element at the tail (the most recently enqueued).
   * Useful for preemption or cancellation of the last-arrived task.
   */
  public dequeueTail(): T | undefined {
    if (this._size === 0) return undefined;
    this.tail = (this.tail - 1 + this._capacity) % this._capacity;
    const value = this.buffer[this.tail];
    this.buffer[this.tail] = undefined;
    this._size--;
    return value;
  }

  /** Remove all elements. */
  public clear(): void {
    this.buffer.fill(undefined);
    this.head = 0;
    this.tail = 0;
    this._size = 0;
  }

  // ─── Queries ───

  /**
   * Access the element at a logical index (0 = head, 1 = second element, etc.).
   * Negative indices count from the tail (-1 = last element).
   * Returns `undefined` for out-of-range indices.
   */
  public at(index: number): T | undefined {
    if (index < 0) index = this._size + index;
    if (index < 0 || index >= this._size) return undefined;
    return this.buffer[(this.head + index) % this._capacity];
  }

  /** Check if `value` is in the queue (by reference equality). */
  public includes(value: T): boolean {
    for (let i = 0; i < this._size; i++) {
      if (this.buffer[(this.head + i) % this._capacity] === value) return true;
    }
    return false;
  }

  /** Return all elements as an array, head to tail. */
  public toArray(): T[] {
    const result: T[] = new Array(this._size);
    for (let i = 0; i < this._size; i++) {
      result[i] = this.buffer[(this.head + i) % this._capacity]!;
    }
    return result;
  }

  // ─── Iteration ───

  /** Iterate values from head to tail. */
  public *values(): IterableIterator<T> {
    for (let i = 0; i < this._size; i++) {
      yield this.buffer[(this.head + i) % this._capacity]!;
    }
  }

  /** Iterate `[index, value]` pairs, where index is the logical position. */
  public *entries(): IterableIterator<[number, T]> {
    for (let i = 0; i < this._size; i++) {
      yield [i, this.buffer[(this.head + i) % this._capacity]!];
    }
  }

  public [Symbol.iterator](): IterableIterator<T> {
    return this.values();
  }

  // ─── Properties ───

  /** Number of elements currently in the queue. */
  public get size(): number {
    return this._size;
  }

  /**
   * Maximum number of elements.
   * - In fixed-capacity mode: the configured capacity.
   * - In auto-grow mode: the current underlying array length (may increase).
   */
  public get capacity(): number {
    return this._capacity;
  }

  /** `true` when the queue contains no elements. */
  public get isEmpty(): boolean {
    return this._size === 0;
  }

  /**
   * `true` when `size` equals the current capacity.
   * In fixed-capacity mode this means `enqueue` will return `false`.
   */
  public get isFull(): boolean {
    return this._size === this._capacity;
  }

  // ─── Internal ───

  #resize(): void {
    const newCap = this._capacity * 2;
    const newBuf: (T | undefined)[] = new Array(newCap);
    for (let i = 0; i < this._size; i++) {
      newBuf[i] = this.buffer[(this.head + i) % this._capacity];
    }
    this.buffer = newBuf;
    this.head = 0;
    this.tail = this._size;
    this._capacity = newCap;
  }
}
