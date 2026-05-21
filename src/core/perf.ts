/**
 * Lightweight async operation timer.
 *
 * Wraps CPU-heavy or I/O operations to measure wall-clock duration,
 * logging a `[perf]` line for local debugging. Use with the `Server-Timing`
 * middleware in `app.ts` for end-to-end timing breakdown.
 *
 * Logging is enabled by default. Call `enablePerf(false)` in production
 * entry points to suppress `console.debug` output (though the overhead
 * is negligible — ~0.001ms per call).
 *
 * @example
 * ```ts
 * import { measure } from '../../core/perf.ts';
 *
 * const result = await measure('PBKDF2 hash', () => crypto.subtle.deriveBits(...));
 * ```
 */

let _enabled = true;
let _lastDuration = 0;

/** Enable or disable [perf] console output at runtime. */
export function enablePerf(on: boolean): void {
  _enabled = on;
}

/** Returns the last measured duration in milliseconds. */
export function lastPerf(): number {
  return _lastDuration;
}

export async function measure<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    _lastDuration = performance.now() - t0;
    if (_enabled) {
      console.debug(`[perf] ${label}: ${_lastDuration.toFixed(1)}ms`);
    }
  }
}
