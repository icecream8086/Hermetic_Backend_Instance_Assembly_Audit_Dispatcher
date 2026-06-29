import type { ITimerBackend, TimerHandle } from './interfaces.ts';

/**
 * Deterministic timer backend for testing.
 *
 * Instead of wall-clock time, the test calls {@link tick()} explicitly to
 * fire the scheduled handler. No `vi.useFakeTimers()` needed.
 *
 * @example
 * ```ts
 * const backend = new FakeTimerBackend();
 * const loop = new EventLoop(bus, { intervalMs: 60000 }, backend);
 * loop.start();
 *
 * backend.tick(); // fires one 60s tick immediately
 * expect(handler).toHaveBeenCalledOnce();
 *
 * loop.stop();
 * ```
 */
export class FakeTimerBackend implements ITimerBackend {
  #handler: (() => void) | null = null;
  #intervalMs = 0;
  #running = false;

  public start(handler: () => void, intervalMs: number): TimerHandle {
    this.#handler = handler;
    this.#intervalMs = intervalMs;
    this.#running = true;
    return {
      clear: () => {
        this.#handler = null;
        this.#running = false;
      },
    };
  }

  /**
   * Fire the scheduled handler once, simulating one tick.
   * No-op if the timer has been cleared / stopped.
   */
  public tick(): void {
    if (this.#running && this.#handler) {
      this.#handler();
    }
  }

  public get isRunning(): boolean {
    return this.#running;
  }

  public get intervalMs(): number {
    return this.#intervalMs;
  }
}
