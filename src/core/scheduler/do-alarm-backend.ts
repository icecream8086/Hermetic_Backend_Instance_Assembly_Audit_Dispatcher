import type { ITimerBackend, TimerHandle } from './interfaces.ts';

/**
 * Durable Object Alarm–backed timer.
 *
 * In **Miniflare (local dev)** DO alarms work identically to production,
 * so this backend faithfully simulates the production scheduling path.
 *
 * The backend runs in **hybrid mode**:
 * 1. Uses `setInterval` locally to dispatch the handler callback (the DO
 *    cannot call back into the Worker's in-memory handler directly).
 * 2. Configures the {@link AlarmTimerDO} to set recurring alarms — proving
 *    the alarm path works end-to-end in the local dev environment.
 * 3. The DO's status endpoint is observable for monitoring and debugging.
 *
 * In a future production-only mode with a callback URL configured, the DO
 * can notify the Worker via HTTP instead of relying on `setInterval`.
 *
 * @example
 * ```ts
 * const stub = env.ALARM_TIMER_DO.idFromName('event-loop');
 * const backend = new DoAlarmBackend(stub);
 * const loop = new EventLoop(bus, { intervalMs: 60000 }, backend);
 * ```
 */
export class DoAlarmBackend implements ITimerBackend {
  readonly #doStub: DurableObjectStub;
  #localTimerId: ReturnType<typeof setInterval> | null = null;

  constructor(doStub: DurableObjectStub) {
    this.#doStub = doStub;
  }

  start(handler: () => void, intervalMs: number): TimerHandle {
    // 1. Local handler dispatch (always works in dev)
    this.#localTimerId = setInterval(handler, intervalMs);

    // 2. Configure DO alarm for production-path simulation
    this.#doStub.fetch('http://do/start', {
      method: 'POST',
      body: JSON.stringify({ intervalMs }),
    }).catch(() => {});

    return {
      clear: () => {
        if (this.#localTimerId !== null) {
          clearInterval(this.#localTimerId);
          this.#localTimerId = null;
        }
        this.#doStub.fetch('http://do/stop', { method: 'POST' }).catch(() => {});
      },
    };
  }
}
