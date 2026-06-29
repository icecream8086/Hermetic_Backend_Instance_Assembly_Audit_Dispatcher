/**
 * Central scheduler registry — unified lifecycle for all timed subsystems.
 *
 * Every scheduler (EventLoop, DagScheduler, future additions) registers
 * here. App startup calls startAll(), shutdown calls stopAll().
 *
 * Pattern: Record<SchedulerName, IScheduler> ensures each scheduler is
 * explicitly named and accounted for at compile time.
 */

import type { IScheduler } from './interfaces.ts';

// ─── Registry ───

const entries = new Map<string, IScheduler>();

/** Register a scheduler. Throws on duplicate names (startup invariant). */
export function register(name: string, scheduler: IScheduler): void {
  if (entries.has(name)) {
    throw new Error(`Scheduler "${name}" is already registered`);
  }
  entries.set(name, scheduler);
}

/** Unregister a scheduler (useful for testing). */
export function unregister(name: string): void {
  entries.delete(name);
}

/** Start all registered schedulers. Idempotent — already-running schedulers are skipped. */
export function startAll(): void {
  for (const [name, s] of entries) {
    const status = s.status();
    if (!status.running) {
      console.log(`[scheduler] Starting ${name} (interval=${String(status.config.intervalMs)}ms)`);
      s.start();
    }
  }
}

/** Stop all registered schedulers. Called during graceful shutdown. */
export function stopAll(): void {
  for (const [, s] of entries) {
    s.stop();
  }
}

/** Return count of registered schedulers (for tests/observability). */
export function count(): number {
  return entries.size;
}

/** List registered scheduler names. */
export function names(): string[] {
  return [...entries.keys()];
}

/** Clear all registrations (for tests only). */
export function reset(): void {
  entries.clear();
}
