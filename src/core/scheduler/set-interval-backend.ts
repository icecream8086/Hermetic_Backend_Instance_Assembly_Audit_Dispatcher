import type { ITimerBackend, TimerHandle } from './interfaces.ts';

/**
 * `setInterval` / `clearInterval` based timer backend.
 *
 * Default for Workers and Node runtimes. Lightweight and delegates to
 * the platform's event loop.
 */
export class SetIntervalBackend implements ITimerBackend {
  start(handler: () => void, intervalMs: number): TimerHandle {
    const id = setInterval(handler, intervalMs);
    return { clear: () => clearInterval(id) };
  }
}
