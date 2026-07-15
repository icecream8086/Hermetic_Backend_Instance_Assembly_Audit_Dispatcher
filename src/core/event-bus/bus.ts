import { z } from 'zod';
import type { Event, EventHandler, EventBusConfig } from './types.ts';

/**
 * In-process pub/sub event bus.
 *
 * Handlers are registered per event type. When an {@link Event} is dispatched
 * all matching handlers are invoked in registration order. Async handlers are
 * awaited; exceptions are routed to the configurable `onError` callback.
 *
 * @example
 * ```ts
 * const bus = new EventBus();
 * bus.on('pod.create', async (e) => {
 *   await createPod(e.payload);
 * });
 * await bus.dispatch(createEvent('pod.create', { name: 'game-01' }));
 * ```
 */
export class EventBus {
  readonly #handlers = new Map<string, Set<EventHandler>>();
  readonly #onError: (error: unknown, event: Event) => void;

  public constructor(config?: EventBusConfig) {
    this.#onError = config?.onError ?? ((err, _event) => { throw err; });
  }

  // ─── Registration ───

  /**
   * Register a handler for a specific event type.
   *
   * Multiple handlers for the same type are invoked in registration order.
   * The same handler reference can be safely re-registered (it is a no-op).
   */
  public on<T>(type: string, handler: EventHandler<T>): void {
    let set = this.#handlers.get(type);
    if (!set) {
      set = new Set();
      this.#handlers.set(type, set);
    }
    set.add(z.custom<EventHandler>().parse(handler));
  }

  /**
   * Remove a previously registered handler.
   * @returns `true` if the handler was found and removed.
   */
  public off<T>(type: string, handler: EventHandler<T>): boolean {
    const h = z.custom<EventHandler>().parse(handler);
    return this.#handlers.get(type)?.delete(h) ?? false;
  }

  /**
   * Remove all handlers for an event type, or all handlers across all types.
   */
  public removeAll(type?: string): void {
    if (type) {
      this.#handlers.delete(type);
    } else {
      this.#handlers.clear();
    }
  }

  // ─── Dispatch ───

  /**
   * Dispatch an event to all registered handlers for its type.
   *
   * All handlers are awaited. If any handler throws, the error is forwarded
   * to the configured `onError` callback, and remaining handlers still run.
   */
  public async dispatch(event: Event): Promise<void> {
    const handlers = this.#handlers.get(event.type);
    if (!handlers || handlers.size === 0) return;

    // Fast path: single handler — no array / allSettled allocation
    if (handlers.size === 1) {
       
      const handler: EventHandler | undefined = handlers.values().next().value;
      if (handler) {
        try {
          const r = handler(event);
          if (r != null) await Promise.resolve(r);
        } catch (err) {
          this.#onError(err, event);
        }
      }
      return;
    }

    const results: Promise<void>[] = [];
    for (const handler of handlers) {
      try {
        const r = handler(event);
        results.push(Promise.resolve(r));
      } catch (err) {
        try { this.#onError(err, event); } catch {
          console.debug("onError must not abort the loop");
        }
      }
    }
    if (results.length > 0) {
      const settled = await Promise.allSettled(results);
      for (const s of settled) {
        if (s.status === 'rejected') {
          try { this.#onError(s.reason, event); } catch {
            console.debug("onError must not abort");
          }
        }
      }
    }
  }

  /** Number of registered event types. */
  public get registeredTypes(): number {
    return this.#handlers.size;
  }

  /** Check if any handlers exist for a given event type. */
  public hasHandlers(type: string): boolean {
    return (this.#handlers.get(type)?.size ?? 0) > 0;
  }
}
