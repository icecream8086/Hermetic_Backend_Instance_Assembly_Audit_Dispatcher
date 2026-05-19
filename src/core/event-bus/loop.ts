import { CircularQueue } from '../circular-queue/queue.ts';
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
  triggerTick(): void;
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
 * @example
 * ```ts
 * const bus = new EventBus();
 * const loop = new EventLoop(bus, { intervalMs: 60000, autoStart: true });
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
  #timerHandle: TimerHandle | null = null;
  #paused = false;
  #processedCount = 0;
  #startTime = 0;
  #config: EventLoopConfig;

  constructor(
    bus: EventBus,
    config?: Partial<EventLoopConfig>,
    timerBackend?: ITimerBackend,
  ) {
    this.#bus = bus;
    this.#timerBackend = timerBackend ?? new SetIntervalBackend();
    this.#queue = new CircularQueue<Event>({ capacity: 0 }); // auto-grow
    this.#config = { ...DEFAULT_EVENT_LOOP_CONFIG, ...config };
    if (this.#config.autoStart) this.start();
  }

  // ─── IEventLoopControl ───

  start(): void {
    if (this.#timerHandle !== null) return;
    this.#paused = false;
    this.#startTime = this.#startTime === 0 ? Date.now() : this.#startTime;
    this.#timerHandle = this.#timerBackend.start(
      () => this.#tick(),
      this.#config.intervalMs,
    );
  }

  stop(): void {
    if (this.#timerHandle === null) return;
    this.#timerHandle.clear();
    this.#timerHandle = null;
    this.#paused = false;
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
    if (config.autoStart !== undefined) {
      this.#config.autoStart = config.autoStart;
    }

    if (restart) {
      this.#timerHandle!.clear();
      this.#timerHandle = this.#timerBackend.start(
        () => this.#tick(),
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
    this.#queue.enqueue(event);
  }

  enqueueTrigger<T>(input: TriggerEventInput<T>): Event {
    const event = eventFromTrigger(input);
    this.#queue.enqueue(event);
    return event;
  }

  get size(): number {
    return this.#queue.size;
  }

  triggerTick(): void {
    this.#tick();
  }

  // ─── Internal ───

  #tick(): void {
    if (this.#paused || this.#queue.isEmpty) return;

    const limit = this.#config.batchSize > 0
      ? Math.min(this.#config.batchSize, this.#queue.size)
      : this.#queue.size;

    for (let i = 0; i < limit; i++) {
      const event = this.#queue.dequeue();
      if (!event) break;
      this.#bus.dispatch(event).catch(() => {});
      this.#processedCount++;
    }
  }
}
