import type { ITimerBackend, SchedulerBackendType } from './interfaces.ts';
import { SetIntervalBackend } from './set-interval-backend.ts';
import { ManualBackend } from './manual-backend.ts';
import { DoAlarmBackend } from './do-alarm-backend.ts';

export interface TimerBackendOptions {
  /** Required when type is `do-alarm`. */
  readonly doNamespace?: DurableObjectNamespace | undefined;
}

/**
 * Create a timer backend from a type discriminator.
 *
 * @example
 * ```ts
 * // Worker backend (default)
 * const backend = createTimerBackend('worker');
 *
 * // DO Alarm backend (local simulation via Miniflare)
 * const backend = createTimerBackend('do-alarm', {
 *   doNamespace: env.ALARM_TIMER_DO,
 * });
 * ```
 */
export function createTimerBackend(type: SchedulerBackendType, options?: TimerBackendOptions): ITimerBackend {
  switch (type) {
    case 'worker':
      return new SetIntervalBackend();
    case 'manual':
      return new ManualBackend();
    case 'do-alarm': {
      if (!options?.doNamespace) {
        throw new Error(
          'Cannot create do-alarm backend: missing doNamespace. ' +
          'Pass { doNamespace: env.ALARM_TIMER_DO } to createTimerBackend().',
        );
      }
      const id = options.doNamespace.idFromName('event-loop');
      const doStub = options.doNamespace.get(id);
      return new DoAlarmBackend(doStub);
    }
  }
}
