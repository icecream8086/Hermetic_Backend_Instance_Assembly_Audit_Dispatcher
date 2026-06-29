// ─── Timer backend (pluggable timing strategy) ───

/**
 * Backend type discriminator, settable via `SCHEDULER_BACKEND` env var.
 *
 * - `worker` — `SetIntervalBackend`, works in Workers & Node (default).
 * - `manual` — no automatic timer; ticks must be triggered externally.
 * - `do-alarm` — `DoAlarmBackend`, DO Alarm–gated scheduling (works in
 *   Miniflare, so local dev simulates production behavior).
 */
export type SchedulerBackendType = 'worker' | 'manual' | 'do-alarm';

/** Opaque handle returned by {@link ITimerBackend.start}. */
export interface TimerHandle {
  /** Cancel the timer. No-op if already cancelled. */
  clear(): void;
}

/**
 * Pluggable timing strategy.
 *
 * Different runtimes can provide different backends:
 * - **Workers / Node**: `SetIntervalBackend` (default).
 * - **DO Alarm**: `DoAlarmBackend` — works in Miniflare and production.
 * - **Manual**: no automatic timer, explicit `tick()` calls.
 * - **Test**: `FakeTimerBackend` — no wall-clock dependency, explicit `tick()`.
 */
export interface ITimerBackend {
  /** Start a recurring timer. Returns a handle to cancel it. */
  start(handler: () => void, intervalMs: number): TimerHandle;
}

// ─── Scheduler lifecycle (common contract for all cron-like subsystems) ───

export interface SchedulerConfig {
  /** Tick interval in milliseconds. */
  intervalMs: number;
  /** Start processing immediately after construction. */
  autoStart: boolean;
}

export interface SchedulerStatus {
  running: boolean;
  paused: boolean;
  uptimeMs: number;
  config: SchedulerConfig;
}

/**
 * Common scheduler lifecycle contract.
 *
 * Implemented by {@link import('../event-bus/loop.ts').EventLoop} and designed
 * for future use by {@link import('../cleanup/interfaces.ts').ICleanupPoller}.
 *
 * @example
 * ```ts
 * function acceptAnyScheduler(s: IScheduler) {
 *   s.start();
 *   s.pause();
 *   s.resume();
 *   console.log(s.status());
 *   s.stop();
 * }
 * ```
 */
export interface IScheduler {
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- interface contract: configure accepts any subset of config fields
  configure(config: Partial<SchedulerConfig>): SchedulerConfig;
  status(): SchedulerStatus;
}
