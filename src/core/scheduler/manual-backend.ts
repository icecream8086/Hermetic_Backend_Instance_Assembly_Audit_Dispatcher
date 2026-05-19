import type { ITimerBackend, TimerHandle } from './interfaces.ts';

/**
 * Timer backend that never fires automatically.
 *
 * Useful when event processing is driven by external triggers
 * (webhooks, DO alarms, manual API calls) rather than a wall-clock timer.
 * The `start()` call is a no-op and returns a no-op handle.
 */
export class ManualBackend implements ITimerBackend {
  start(_handler: () => void, _intervalMs: number): TimerHandle {
    return { clear: () => {} };
  }
}
