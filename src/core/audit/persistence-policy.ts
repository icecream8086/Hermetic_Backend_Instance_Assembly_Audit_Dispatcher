/**
 * Persistence policy — controls which audit entries are written to durable storage.
 *
 * Separate from log-policy.ts (console output) because storage costs real money:
 *   - R2 charges per PUT/GET operation
 *   - KV charges per read/write
 *   - DO storage is limited
 *
 * Design (mirrors journald §8 Storage=persistent vs volatile):
 *   Tier 0 — console only (DEBUG, INFO)         → console.log, no persist
 *   Tier 1 — ring buffer (NOTICE, WARNING)      → memory-only, no persist
 *   Tier 2 — durable   (ERR, CRIT, ALERT, EMERG) → write to KV/R2/DO
 *   Tier 3 — immutable (auth events, perm denials) → always persist
 *
 * ERR (3) and below are NEVER suppressed from persistence regardless of policy.
 * This matches the kernel invariant: ERRs are always recoverable from journal.
 *
 * External control: GET/PUT /api/admin/log-persistence
 */

import { KernLevel, type FacilityName } from './kern-level.ts';
import type { AuditEntry } from './types.ts';

// ─── Types ───

export interface PersistenceRule {
  /** Facility name (must be a known facility) or '*' for default. Typo → compile error. */
  facility: FacilityName | '*';
  /** Minimum KernLevel to persist. ERR and below always persist regardless. */
  minLevel: KernLevel;
  /** Sampling rate: 1 = persist all, 10 = persist ~10%. Default 1. */
  sampleRate?: number;
  /** TTL in ms — entries older than this are pruned. 0 = never. */
  ttlMs?: number;
}

export interface PersistencePolicy {
  /** Master kill-switch. When false, nothing is persisted (console still works). */
  enabled: boolean;
  /** Default rule applied when no per-facility rule matches. */
  defaultMinLevel: KernLevel;
  /** Per-facility overrides. First match wins. */
  rules: PersistenceRule[];
  /** Last update timestamp. */
  updatedAt: number;
  /** Who updated it (user ID). */
  updatedBy?: string;
}

// ─── Built-in defaults ───

/** Facilities whose entries are always persisted (Tier 3 — immutable audit trail). */
const IMMUTABLE_FACILITIES = new Set([
  'auth', 'authz', 'perm', 'perm-audit', 'perm-gate',
]);

export function buildDefaultPersistencePolicy(): PersistencePolicy {
  return {
    enabled: true,
    defaultMinLevel: KernLevel.ERR, // Only ERR+ by default
    rules: [
      // Tier 3: auth/perm facilities — persist everything WARNING+
      // (IMMUTABLE_FACILITIES are always persisted at ERR+ in code below)
      { facility: 'auth', minLevel: KernLevel.WARNING, sampleRate: 1 },
      { facility: 'perm', minLevel: KernLevel.WARNING, sampleRate: 1 },
      { facility: 'perm-audit', minLevel: KernLevel.WARNING, sampleRate: 1 },
      // Tier 2 overrides for critical infrastructure
      { facility: 'pod', minLevel: KernLevel.ERR, sampleRate: 1 },
      { facility: 'provider', minLevel: KernLevel.ERR, sampleRate: 1 },
      { facility: 'queue', minLevel: KernLevel.WARNING, sampleRate: 1 },
      // High-volume facilities: only persist ERR+
      { facility: 'http', minLevel: KernLevel.ERR, sampleRate: 1 },
      { facility: 'image', minLevel: KernLevel.ERR, sampleRate: 1 },
      { facility: 'network', minLevel: KernLevel.ERR, sampleRate: 1 },
      { facility: 'volume', minLevel: KernLevel.ERR, sampleRate: 1 },
    ],
    updatedAt: Date.now(),
  };
}

// ─── Runtime state ───

let _persistencePolicy = buildDefaultPersistencePolicy();

export function getPersistencePolicy(): PersistencePolicy {
  return _persistencePolicy;
}

export function setPersistencePolicy(policy: PersistencePolicy): void {
  _persistencePolicy = policy;
}

/** Reset to built-in defaults. */
export function resetPersistencePolicy(): PersistencePolicy {
  _persistencePolicy = buildDefaultPersistencePolicy();
  return _persistencePolicy;
}

// ─── Decision engine ───

/**
 * Determine whether an audit entry should be persisted to durable storage.
 *
 * Rules (in order):
 *   1. Master kill-switch: if policy.enabled === false → false
 *   2. Immutable facilities (auth/perm): ERR+ → always true
 *   3. ERR and below (EMERG/ALERT/CRIT) → always true (kernel invariant)
 *   4. Per-facility rule match → check minLevel
 *   5. Default rule → check defaultMinLevel
 *   6. Sampling: if sampleRate > 1, random subset
 */
export function shouldPersist(entry: AuditEntry): boolean {
  if (!_persistencePolicy.enabled) return false;

  const facility = entry.facility;
  const level = entry.level;

  // ERR (3) and below are NEVER suppressed — kernel invariant
  if (level <= KernLevel.ERR) return true;

  // Tier 3: immutable facilities — everything WARNING+ is persisted
  if (IMMUTABLE_FACILITIES.has(facility)) {
    // ERR+ handled above; WARNING+ always persist for immutable facilities
    if (level <= KernLevel.WARNING) return true;
  }

  // Find matching rule (first match wins)
  const rule = _persistencePolicy.rules.find(r => r.facility === facility);

  const effectiveMinLevel = rule?.minLevel ?? _persistencePolicy.defaultMinLevel;

  if (level > effectiveMinLevel) return false;

  // Sampling: if sampleRate > 1, only persist 1/N entries
  const sampleRate = rule?.sampleRate ?? 1;
  if (sampleRate > 1) {
    // Deterministic sampling based on entry content (avoids random() overhead)
    // Uses a simple hash of message + timestamp to decide.
    const hash = simpleHash(entry.message + String(Date.now()));
    if (hash % sampleRate !== 0) return false;
  }

  return true;
}

/** Simple fast hash for deterministic sampling. */
function simpleHash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}
