/**
 * Runtime log policy — controls which KernLevel is output per facility.
 *
 * Only `updateLogPolicy()` (PUT) updates the runtime state.  GET has no
 * side effects.  ERR and below are NEVER suppressed regardless of policy.
 */

import type { LogPolicy } from '../../features/permission/types.ts';
import { KernLevel } from '../audit/kern-level.ts';

// ─── Built-in defaults ───

function defaultKernLevel(): KernLevel {
  const env = process.env.LOG_LEVEL?.toLowerCase();
  if (env === 'debug')  return KernLevel.DEBUG;
  if (env === 'notice') return KernLevel.NOTICE;
  if (env === 'warning') return KernLevel.WARNING;
  if (env === 'error')  return KernLevel.ERR;
  return process.env.NODE_ENV === 'production' ? KernLevel.INFO : KernLevel.DEBUG;
}

function defaultAuditKernLevel(): KernLevel {
  const env = process.env.AUDIT_LEVEL?.toLowerCase();
  if (env === 'debug')  return KernLevel.DEBUG;
  if (env === 'notice') return KernLevel.NOTICE;
  if (env === 'warning') return KernLevel.WARNING;
  if (env === 'error')  return KernLevel.ERR;
  return defaultKernLevel();
}

/** KernLevel number → name string (const enums can't use index access with runtime values) */
function kernToName(l: KernLevel): string {
  switch (l) {
    case KernLevel.EMERG: return 'emerg';
    case KernLevel.ALERT: return 'alert';
    case KernLevel.CRIT: return 'crit';
    case KernLevel.ERR: return 'err';
    case KernLevel.WARNING: return 'warning';
    case KernLevel.NOTICE: return 'notice';
    case KernLevel.INFO: return 'info';
    case KernLevel.DEBUG: return 'debug';
  }
}

export const DEFAULT_POLICY: LogPolicy = {
  defaultLevel: kernToName(defaultKernLevel()),
  auditLevel: kernToName(defaultAuditKernLevel()),
  facilities: [],
  updatedAt: Date.now(),
};

let _active = DEFAULT_POLICY;

export function setActivePolicy(policy: LogPolicy): void {
  _active = policy;
}

export function getActivePolicy(): LogPolicy {
  return _active;
}

const NAME_TO_KERN: Record<string, KernLevel | 99> = {
  debug: KernLevel.DEBUG,
  info: KernLevel.INFO,
  notice: KernLevel.NOTICE,
  warning: KernLevel.WARNING,
  warn: KernLevel.WARNING,
  error: KernLevel.ERR,
  err: KernLevel.ERR,
  fatal: KernLevel.CRIT,
  crit: KernLevel.CRIT,
  emerg: KernLevel.EMERG,
  alert: KernLevel.ALERT,
  none: 99, // "none" means log nothing — sentinel value, always suppressed
};

/** Parse a policy string level back to KernLevel. "none" returns 99 — no level passes. */
export function policyLevelToKern(name: string): KernLevel | 99 {
  return NAME_TO_KERN[name.toLowerCase()] ?? KernLevel.INFO;
}

/**
 * Check if a given facility + KernLevel should be output.
 *
 * ERR (3) and below (EMERG/ALERT/CRIT) are NEVER suppressed.
 */
export function shouldLog(facility: string, level: KernLevel): boolean {
  if (level <= KernLevel.ERR) return true;
  const effective = _active.facilities.find(f => f.facility === facility);
  const minLevel = effective?.level ?? _active.defaultLevel;
  return level <= policyLevelToKern(minLevel);
}

/** Gate debug output. Only prints when the facility allows DEBUG level. */
export function debugLog(facility: string, message: string, ...args: unknown[]): void {
  if (shouldLog(facility, KernLevel.DEBUG)) {
    console.error(`[debug][${facility}] ${message}`, ...args);
  }
}

/** Check audit entry — ERR (3) and below always pass. */
export function shouldLogAudit(facility: string, level: KernLevel): boolean {
  if (level <= KernLevel.ERR) return true;
  return shouldLog(facility, level);
}
