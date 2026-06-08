/**
 * Runtime log policy — controls which log levels are output per facility.
 *
 * Only `updateLogPolicy()` (PUT) updates the runtime state.  GET has no
 * side effects.  ERR/FATAL audit entries are NEVER suppressed regardless
 * of policy — they always print.
 */

import type { LogPolicy } from '../../features/permission/types.ts';
import { KernLevel } from '../audit/kern-level.ts';

// ─── Built-in defaults (single source of truth) ───

/** Default log level — override via LOG_LEVEL env var or NODE_ENV. */
function defaultLevel(): string {
  return process.env['LOG_LEVEL']?.toLowerCase()
    ?? (process.env['NODE_ENV'] === 'production' ? 'info' : 'debug');
}

export const DEFAULT_POLICY: LogPolicy = {
  defaultLevel: defaultLevel(),
  auditLevel: defaultLevel(),
  facilities: [],
  updatedAt: Date.now(),
};

let _active = DEFAULT_POLICY;

/** Update runtime policy — called from PUT handler only. */
export function setActivePolicy(policy: LogPolicy): void {
  _active = policy;
}

export function getActivePolicy(): LogPolicy {
  return _active;
}

/** Level weights — higher = more severe. */
const LEVEL_WEIGHTS: Record<string, number> = {
  debug: 0,
  info: 1,
  notice: 2,
  warning: 3,
  error: 4,
  fatal: 5,
};

export function weight(lvl: string): number {
  return LEVEL_WEIGHTS[lvl.toLowerCase()] ?? 1;
}

/**
 * Check if a given facility+level should be output.
 *
 * ERR and FATAL levels are NEVER suppressed — they always print.
 * For all other levels, the facility's configured threshold is checked.
 */
export function shouldLog(facility: string, level: string): boolean {
  const w = weight(level);
  // ERR (4) and FATAL (5) are always allowed through
  if (w >= 4) return true;
  const effective = _active.facilities.find(f => f.facility === facility);
  const minLevel = effective?.level ?? _active.defaultLevel;
  return w >= weight(minLevel);
}

// ─── KernLevel bridge ───

function kernToName(level: KernLevel): string {
  switch (level) {
    case KernLevel.EMERG: return 'fatal';
    case KernLevel.ALERT: return 'error';
    case KernLevel.CRIT: return 'error';
    case KernLevel.ERR: return 'error';
    case KernLevel.WARNING: return 'warning';
    case KernLevel.NOTICE: return 'notice';
    case KernLevel.INFO: return 'info';
    case KernLevel.DEBUG: return 'debug';
    default: return 'info';
  }
}

/**
 * Gate debug console output behind the active log policy.
 * Use this for noisy debug-print statements in providers and core modules.
 * Only prints when the facility allows 'debug' level.
 */
export function debugLog(facility: string, message: string, ...args: unknown[]): void {
  if (shouldLog(facility, 'debug')) {
    console.error(`[debug][${facility}] ${message}`, ...args);
  }
}

/** Check audit entry — ERR and below always pass. */
export function shouldLogAudit(facility: string, level: KernLevel): boolean {
  if (level <= KernLevel.ERR) return true; // EMERG(0) … ERR(3) 永不跳过
  return shouldLog(facility, kernToName(level));
}
