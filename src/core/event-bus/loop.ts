import { CircularQueue } from '../circular-queue/queue.ts';
import type { IAtomicStore } from '../store/interfaces.ts';
import type { ITimerBackend, TimerHandle } from '../scheduler/interfaces.ts';
import { SetIntervalBackend } from '../scheduler/set-interval-backend.ts';
import type { EventBus } from './bus.ts';
import type {
  Event,
  TriggerEventInput,
  EventLoopConfig,
  EventLoopStatus,
} from './types.ts';
import { eventFromTrigger, DEFAULT_EVENT_LOOP_CONFIG } from './types.ts';

// ─── Store keys ───

const KEY_PENDING = 'events:pending';

/**
 * Public control surface for the event loop.
 *
 * Designed to be easily wrapped by Hono routes — every method either
 * returns `void` or a JSON-serialisable value so Worker endpoints can
 * delegate directly through.
 *
 * @example
 * ```ts
 * // POST /api/events/loop/start
 * loop.start();
 *
 * // POST /api/events/loop/configure
 * loop.configure({ intervalMs: 30000 });
 *
 * // GET /api/events/loop/status
 * return c.json(loop.status());
 * ```
 */
export interface IEventLoopControl {
  /** Start processing queued events. No-op if already running. */
  start(): void;
  /** Stop processing. No-op if not running. */
  stop(): void;
  /** Pause processing; events continue to accumulate. */
  pause(): void;
  /** Resume processing after a pause. */
  resume(): void;
  /**
   * Update runtime configuration.
   * @returns the merged config after applying changes.
   */
  configure(config: Partial<EventLoopConfig>): EventLoopConfig;
  /** Snapshot of current state. */
  status(): EventLoopStatus;

  /** Enqueue an event for processing. */
  enqueue(event: Event): void;
  /**
   * Convenience: create an Event from a public TriggerEventInput and enqueue it.
   * This is the method external HTTP callers route through.
   */
  enqueueTrigger<T>(input: TriggerEventInput<T>): Event;

  /**
   * Enqueue a system event that bypasses the maxQueueSize limit.
   * Use for critical internal events (health:check, etc.) that must
   * never be dropped due to queue pressure.
   */
  enqueuePriority<T>(input: TriggerEventInput<T>): Event;

  /** List pending events in the queue (type + id, no payload). */
  pendingEvents(): { type: string; id: string }[];

  /** Current number of pending events. */
  readonly size: number;

  /**
   * Manually trigger a tick, bypassing the timer backend.
   *
   * Useful for:
   * - DO Alarm callbacks (DO fires → calls `triggerTick()` via HTTP)
   * - `wrangler dev --test-scheduled` endpoint
   * - Manual API-driven dispatch
   */
  triggerTick(): Promise<void>;
}

/**
 * Round-robin event loop built on {@link CircularQueue}.
 *
 * Queues incoming events and dispatches them via an {@link EventBus} on a
 * configurable timer. Supports start/stop/pause/resume lifecycle and
 * runtime configuration changes — all exposed through {@link IEventLoopControl}
 * for easy HTTP API wrapping.
 *
 * The timing backend is injectable (defaults to {@link SetIntervalBackend}),
 * making the loop testable without wall-clock dependencies and deployable
 * with Workers-native {@link import('../scheduler/interfaces.ts').ITimerBackend
 * ITimerBackend} implementations.
 *
 * When an {@link IAtomicStore} is provided (4th constructor param), events
 * are persisted atomically — they survive Worker restarts and are recovered
 * on the next construction. The store bridges through the existing DO / KV
 * abstraction layer so it works with any backend.
 *
 * @example
 * ```ts
 * // In-memory only
 * const loop = new EventLoop(bus, { intervalMs: 60000 });
 *
 * // Persistent (survives restarts via DO / KV)
 * const loop = new EventLoop(bus, { intervalMs: 60000 }, undefined, stores.atomic);
 *
 * // Wire up a Hono route:
 * app.post('/api/events', async (c) => {
 *   const input = await c.req.json<TriggerEventInput>();
 *   const event = loop.enqueueTrigger(input);
 *   return c.json({ id: event.id }, 202);
 * });
 *
 * app.get('/api/events/loop/status', (c) => c.json(loop.status()));
 * ```
 */
export class EventLoop implements IEventLoopControl {
  readonly #queue: CircularQueue<Event>;
  readonly #bus: EventBus;
  readonly #timerBackend: ITimerBackend;
  readonly #store: IAtomicStore | undefined;
  #timerHandle: TimerHandle | null = null;
  #paused = false;
  #ticking = false;
  #processedCount = 0;
  #startTime = 0;
  #config: EventLoopConfig;

  constructor(
    bus: EventBus,
    config?: Partial<EventLoopConfig>,
    timerBackend?: ITimerBackend,
    store?: IAtomicStore,
  ) {
    this.#bus = bus;
    this.#timerBackend = timerBackend ?? new SetIntervalBackend();
    this.#queue = new CircularQueue<Event>({ capacity: 0 }); // auto-grow
    this.#config = { ...DEFAULT_EVENT_LOOP_CONFIG, ...config };
    this.#store = store;
    if (this.#store) this.#recover().catch(err => { this.#reportError(err, 'recover'); });
    if (this.#config.autoStart) this.start();
  }

  // ─── IEventLoopControl ───

  start(): void {
    if (this.#timerHandle !== null) return;
    this.#paused = false;
    this.#startTime = this.#startTime === 0 ? Date.now() : this.#startTime;
    this.#timerHandle = this.#timerBackend.start(
      () => { this.#tick().catch(err => { this.#reportError(err, 'tick'); }); },
      this.#config.intervalMs,
    );
  }

  stop(): void {
    if (this.#timerHandle === null) return;
    this.#timerHandle.clear();
    this.#timerHandle = null;
    this.#paused = false;
    this.#startTime = 0;
  }

  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    this.#paused = false;
  }

  configure(config: Partial<EventLoopConfig>): EventLoopConfig {
    let restart = false;

    if (config.intervalMs !== undefined && config.intervalMs > 0) {
      this.#config.intervalMs = config.intervalMs;
      if (this.#timerHandle !== null) restart = true;
    }
    if (config.batchSize !== undefined) {
      this.#config.batchSize = config.batchSize;
    }
    if (config.maxQueueSize !== undefined) {
      this.#config.maxQueueSize = config.maxQueueSize;
    }
    if (config.onError !== undefined) {
      this.#config.onError = config.onError;
    }

    if (restart) {
      this.#timerHandle!.clear();
      this.#timerHandle = this.#timerBackend.start(
        () => { this.#tick().catch(err => { this.#reportError(err, 'tick'); }); },
        this.#config.intervalMs,
      );
    }

    return { ...this.#config };
  }

  status(): EventLoopStatus {
    return {
      running: this.#timerHandle !== null,
      paused: this.#paused,
      queueSize: this.#queue.size,
      processedCount: this.#processedCount,
      uptimeMs: this.#startTime > 0 ? Date.now() - this.#startTime : 0,
      config: { ...this.#config },
    };
  }

  enqueue(event: Event): void {
    if (this.#config.maxQueueSize > 0 && this.#queue.size >= this.#config.maxQueueSize) {
      this.#reportError(
        new Error(`Queue full (${this.#queue.size} >= ${this.#config.maxQueueSize})`),
        'enqueue',
      );
      return;
    }
    // Persist BEFORE memory enqueue to close the crash window.
    // If persist is in-flight when crash occurs, the event is in the store
    // and will be recovered on restart (at-least-once delivery).
    if (this.#store) this.#persistEnqueue(event).catch(err => { this.#reportError(err, 'persist-enqueue'); });
    this.#queue.enqueue(event);
  }

  enqueueTrigger<T>(input: TriggerEventInput<T>): Event {
    const event = eventFromTrigger(input);
    if (this.#config.maxQueueSize > 0 && this.#queue.size >= this.#config.maxQueueSize) {
      this.#reportError(
        new Error(`Queue full (${this.#queue.size} >= ${this.#config.maxQueueSize})`),
        'enqueue',
      );
      return event;
    }
    if (this.#store) this.#persistEnqueue(event).catch(err => { this.#reportError(err, 'persist-enqueue'); });
    this.#queue.enqueue(event);
    return event;
  }

  enqueuePriority<T>(input: TriggerEventInput<T>): Event {
    const event = eventFromTrigger(input);
    if (this.#store) this.#persistEnqueue(event).catch(err => { this.#reportError(err, 'persist-enqueue'); });
    this.#queue.enqueue(event);
    return event;
  }

  pendingEvents(): { type: string; id: string }[] {
    return this.#queue.toArray().map(e => ({ type: e.type, id: e.id }));
  }

  get size(): number {
    return this.#queue.size;
  }

  async triggerTick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      await this.#tick();
    } catch (err) {
      this.#reportError(err, 'tick');
    } finally {
      this.#ticking = false;
    }
  }

  // ─── Internal ───

  #reportError(err: unknown, context: string): void {
    this.#config.onError?.(err, context);
  }

  async #tick(): Promise<void> {
    if (this.#paused || this.#queue.isEmpty) return;

    const limit = this.#config.batchSize > 0
      ? Math.min(this.#config.batchSize, this.#queue.size)
      : this.#queue.size;

    // Dequeue batch first so the queue is drained before we await I/O.
    const dispatched: Event[] = [];
    for (let i = 0; i < limit; i++) {
      const event = this.#queue.dequeue();
      if (!event) break;
      dispatched.push(event);
      this.#processedCount++;
    }

    // Await batch dispatch — provides backpressure so only one batch
    // processes at a time.  Prevents unbounded queue growth when dispatch
    // handlers are slower than the tick interval.
    const results = await Promise.allSettled(dispatched.map(e => this.#bus.dispatch(e)));
    for (const r of results) {
      if (r.status === 'rejected') this.#reportError(r.reason, 'dispatch');
    }

    if (this.#store && dispatched.length > 0) {
      try {
        await this.#persistDequeue(dispatched);
      } catch (err) {
        this.#reportError(err, 'persist-dequeue');
      }
    }
  }

  // ─── Store persistence ───

  /** Recover pending events from store after construction. */
  async #recover(): Promise<void> {
    try {
      await this.#store!.transact(async (txn) => {
        const pending = await txn.get<Event[]>(KEY_PENDING);
        if (!pending) return;
        for (const event of pending) {
          if (event.type === 'health:check') continue;
          this.#queue.enqueue(event);
        }
        txn.set(KEY_PENDING, []);
      });
    } catch (err) {
      this.#reportError(err, 'recover');
    }
  }

  /** Event types that should survive Worker restarts (image.pull, user events). */
  static #PERSISTED_TYPES = new Set(['image.pull']);

  /** Append one event to the persisted queue (transient events skipped). */
  async #persistEnqueue(event: Event): Promise<void> {
    if (!EventLoop.#PERSISTED_TYPES.has(event.type)) return;
    await this.#store!.transact(async (txn) => {
      const pending = (await txn.get<Event[]>(KEY_PENDING)) ?? [];
      pending.push(event);
      txn.set(KEY_PENDING, pending);
    });
  }

  /** Remove dispatched events from the persisted queue. */
  async #persistDequeue(events: Event[]): Promise<void> {
    const dispatched = new Set(events.map(e => e.id));
    await this.#store!.transact(async (txn) => {
      const pending = (await txn.get<Event[]>(KEY_PENDING)) ?? [];
      txn.set(KEY_PENDING, pending.filter(e => !dispatched.has(e.id)));
    });
  }
}
