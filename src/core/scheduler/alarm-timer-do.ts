/// <reference types="@cloudflare/workers-types" />

/**
 * Durable Object that acts as a recurring alarm timer.
 *
 * This is the **only** reliable timing source in a Workers environment —
 * DO Alarm has a single-threaded, consistent clock, unlike Worker isolates
 * where `setInterval` / `Date.now()` can diverge across instances (clock wall).
 *
 * On each alarm fire, the DO:
 * 1. Calls back to the Worker via `fetch(callbackUrl)` to trigger a tick.
 * 2. Re-schedules the next alarm.
 *
 * Works identically in Miniflare (local dev) and production Cloudflare.
 *
 * When no `callbackUrl` is configured, the DO still sets recurring alarms
 * for observability, but the actual tick dispatch is handled locally.
 *
 * @example
 * ```ts
 * // Worker fetch handler:
 * const stub = env.ALARM_TIMER_DO.idFromName('event-loop');
 * await stub.fetch('http://do/start', {
 *   method: 'POST',
 *   body: JSON.stringify({ intervalMs: 60000, callbackUrl: 'http://localhost:8787/__scheduled' }),
 * });
 * ```
 */
export class AlarmTimerDO implements DurableObject {
  readonly ctx: DurableObjectState;
  readonly #minInterval = 1000; // DO alarm minimum safety floor
  #intervalMs = 60000;
  #callbackUrl = '';
  #running = false;
  #tickCount = 0;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith('/start')) {
      const body = await request.json() as { intervalMs: number; callbackUrl?: string };
      this.#intervalMs = Math.max(body.intervalMs, this.#minInterval);
      this.#callbackUrl = body.callbackUrl ?? '';
      this.#running = true;
      await this.ctx.storage.setAlarm(Date.now() + this.#intervalMs);
      return Response.json({
        ok: true,
        intervalMs: this.#intervalMs,
        hasCallback: !!body.callbackUrl,
      });
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
        hasCallback: !!this.#callbackUrl,
        nextAlarm,
      });
    }

    return new Response('not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    if (!this.#running) return;
    this.#tickCount++;

    // Notify the Worker via callback URL (production path).
    // The Worker's route dispatches to loop.triggerTick().
    if (this.#callbackUrl) {
      try {
        await fetch(this.#callbackUrl, { method: 'POST' });
      } catch {
        // callback failure is logged but doesn't stop re-scheduling
      }
    }

    // Re-schedule next alarm
    await this.ctx.storage.setAlarm(Date.now() + this.#intervalMs);
  }
}
