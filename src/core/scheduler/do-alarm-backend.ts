import type { ITimerBackend, TimerHandle } from './interfaces.ts';

/**
 * Durable Object Alarm–backed timer.
 *
 * **Production** (with `callbackUrl`):
 * The DO Alarm is the sole timing source — no `setInterval`, no clock wall.
 * The DO fires → calls `callbackUrl` via `fetch()` → Worker route →
 * `loop.triggerTick()`. Reliable across all Worker isolates.
 *
 * **Local dev** (without `callbackUrl`):
 * Falls back to `setInterval` + DO alarm overlay for observability.
 *
 * @example
 * ```ts
 * // Production: callback drives the tick
 * const backend = new DoAlarmBackend(stub, 'http://my-worker/__scheduled');
 *
 * // Local dev: setInterval fallback
 * const backend = new DoAlarmBackend(stub);
 * ```
 */
export class DoAlarmBackend implements ITimerBackend {
  readonly #doStub: DurableObjectStub;
  readonly #callbackUrl: string | undefined;
  #localTimerId: ReturnType<typeof setInterval> | null = null;

  public constructor(doStub: DurableObjectStub, callbackUrl?: string  ) {
    this.#doStub = doStub;
    this.#callbackUrl = callbackUrl;
  }

  public start(handler: () => void, intervalMs: number): TimerHandle {
    // In production mode (callbackUrl set), the DO alarm drives the tick
    // via HTTP callback — the handler is wired through the Worker route.
    // In dev mode, use setInterval to call the handler directly.
    if (!this.#callbackUrl) {
      this.#localTimerId = setInterval(handler, intervalMs);
    }

    // Configure DO alarm in both modes (for observability / production path)
    try {
      this.#doStub.fetch('http://do/start', {
        method: 'POST',
        body: JSON.stringify({ intervalMs, callbackUrl: this.#callbackUrl }),
      });
    } catch {
      console.debug("noop");
    }
    return {
      clear: () => {
        if (this.#localTimerId !== null) {
          clearInterval(this.#localTimerId);
          this.#localTimerId = null;
        }
        try { this.#doStub.fetch('http://do/stop', { method: 'POST' }); } catch {
          console.debug("noop");
        }
      },
    };
  }
}
