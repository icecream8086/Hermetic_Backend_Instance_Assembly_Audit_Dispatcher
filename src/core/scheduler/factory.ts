import type { ITimerBackend, SchedulerBackendType } from './interfaces.ts';
import { SetIntervalBackend } from './set-interval-backend.ts';
import { ManualBackend } from './manual-backend.ts';
import { DoAlarmBackend } from './do-alarm-backend.ts';

export interface TimerBackendOptions {
  /** Required when type is `do-alarm`. */
  readonly doNamespace?: DurableObjectNamespace | undefined;
  /**
   * Callback URL the DO Alarm calls to trigger the tick.
   * In production: `https://my-worker/__scheduled`.
   * In dev (with `wrangler dev --test-scheduled`): `http://localhost:8787/__scheduled`.
   * When omitted, falls back to `setInterval` (dev mode).
   */
  readonly callbackUrl?: string | undefined;
}

/**
 * Create a timer backend from a type discriminator.
 *
 * @example
 * ```ts
 * // Worker backend (default)
 * const backend = createTimerBackend('worker');
 *
 * // DO Alarm backend with callback (production — no setInterval)
 * const backend = createTimerBackend('do-alarm', {
 *   doNamespace: env.ALARM_TIMER_DO,
 *   callbackUrl: 'https://my-worker/__scheduled',
 * });
 *
 * // DO Alarm backend without callback (dev — setInterval fallback)
 * const backend = createTimerBackend('do-alarm', {
 *   doNamespace: env.ALARM_TIMER_DO,
 * });
 * ```
 */
export function createTimerBackend(type: SchedulerBackendType, options?: TimerBackendOptions): ITimerBackend {
  // Auto-upgrade only when callbackUrl is set (production-ready).
  // In dev without WORKER_URL, keep setInterval — DO alarm in workerd
  // requires continuous I/O to fire, and stalls when the Worker is idle.
  if (type === 'worker' && options?.doNamespace && options.callbackUrl) {
    type = 'do-alarm';
  }

  switch (type) {
    case 'worker':
      return new SetIntervalBackend();
    case 'manual':
      return new ManualBackend();
    case 'do-alarm': {
      if (!options?.doNamespace) {
        // Without DO namespace, fall back to setInterval
        return new SetIntervalBackend();
      }
      const id = options.doNamespace.idFromName('event-loop');
      const doStub = options.doNamespace.get(id);
      return new DoAlarmBackend(doStub, options.callbackUrl);
    }
  }
}
