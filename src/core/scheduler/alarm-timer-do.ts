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
 * Note: Uses `_`-prefixed properties instead of `#` private fields to avoid
 * a workerd crash on Windows when private fields are used in Durable Object
 * classes.
 *
 * @example
 * ```ts
 * const stub = env.ALARM_TIMER_DO.idFromName('event-loop');
 * await stub.fetch('http://do/start', {
 *   method: 'POST',
 *   body: JSON.stringify({ intervalMs: 60000, callbackUrl: 'http://localhost:8787/__scheduled' }),
 * });
 * ```
 */
export class AlarmTimerDO implements DurableObject {
  constructor(readonly ctx: DurableObjectState, _env: unknown) {}

  /** Minimum interval safety floor (1s). DO alarms below this risk instability. */
  static readonly MIN_INTERVAL = 1000;

  _intervalMs = 60000;
  _callbackUrl = '';
  _running = false;
  _tickCount = 0;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith('/start')) {
      const body = await request.json() as { intervalMs: number; callbackUrl?: string };
      this._intervalMs = Math.max(body.intervalMs, AlarmTimerDO.MIN_INTERVAL);
      this._callbackUrl = body.callbackUrl ?? '';
      this._running = true;
      await this.ctx.storage.setAlarm(Date.now() + this._intervalMs);
      return Response.json({
        ok: true,
        intervalMs: this._intervalMs,
        hasCallback: !!body.callbackUrl,
      });
    }

    if (url.pathname.endsWith('/stop')) {
      this._running = false;
      await this.ctx.storage.deleteAlarm();
      return Response.json({ ok: true });
    }

    if (url.pathname.endsWith('/status')) {
      const nextAlarm = await this.ctx.storage.getAlarm();
      return Response.json({
        running: this._running,
        intervalMs: this._intervalMs,
        tickCount: this._tickCount,
        hasCallback: !!this._callbackUrl,
        nextAlarm,
      });
    }

    return new Response('not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    if (!this._running) return;
    this._tickCount++;

    if (this._callbackUrl) {
      try {
        await fetch(this._callbackUrl, { method: 'POST' });
      } catch {
        // callback failure doesn't stop re-scheduling
      }
    }

    await this.ctx.storage.setAlarm(Date.now() + this._intervalMs);
  }
}
