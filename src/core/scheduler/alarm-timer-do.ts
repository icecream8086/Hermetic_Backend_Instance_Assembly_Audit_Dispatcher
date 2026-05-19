/// <reference types="@cloudflare/workers-types" />

/**
 * Durable Object that acts as a recurring alarm timer.
 *
 * In Miniflare (local dev), DO Alarm works identically to production,
 * making this a reliable local simulation of cron-like scheduling.
 *
 * The alarm fires repeatedly at the configured interval. Each firing
 * re-schedules the next. The DO exposes a status endpoint so the
 * Worker can observe alarm state (next fire time, running count, etc.).
 *
 * @example
 * ```ts
 * // Worker fetch handler:
 * const stub = env.ALARM_TIMER_DO.idFromName('event-loop');
 * await stub.fetch('http://do/start', {
 *   method: 'POST',
 *   body: JSON.stringify({ intervalMs: 60000 }),
 * });
 * ```
 */
export class AlarmTimerDO implements DurableObject {
  readonly ctx: DurableObjectState;
  #intervalMs = 60000;
  #running = false;
  #tickCount = 0;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith('/start')) {
      const { intervalMs } = await request.json() as { intervalMs: number };
      this.#intervalMs = intervalMs;
      this.#running = true;
      await this.ctx.storage.setAlarm(Date.now() + this.#intervalMs);
      return Response.json({ ok: true, intervalMs: this.#intervalMs });
    }

    if (url.pathname.endsWith('/stop')) {
      this.#running = false;
      await this.ctx.storage.deleteAlarm();
      return Response.json({ ok: true });
    }

    if (url.pathname.endsWith('/status')) {
      const nextAlarm = await this.ctx.storage.getAlarm();
      return Response.json({
        running: this.#running,
        intervalMs: this.#intervalMs,
        tickCount: this.#tickCount,
        nextAlarm,
      });
    }

    return new Response('not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    if (!this.#running) return;
    this.#tickCount++;
    await this.ctx.storage.setAlarm(Date.now() + this.#intervalMs);
  }
}
