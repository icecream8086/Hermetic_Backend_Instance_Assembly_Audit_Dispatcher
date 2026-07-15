import { describe, it, expect } from 'vitest';
import {
  selectEntriesToPrune,
  estimateEntrySize,
  DEFAULT_ROTATION,
  PRODUCTION_ROTATION,
} from '../../../src/core/audit/rotation.ts';
import type { LogRotationConfig } from '../../../src/core/audit/rotation.ts';
import type { StoredAuditEntry } from '../../../src/core/audit/types.ts';

// ─── Helpers ───

function entry(id: string, timestamp: number, message = 'msg', metadata?: Record<string, unknown>): StoredAuditEntry {
  return { id, timestamp, level: 5 as any, facility: 'auth', message, metadata };
}

function cfg(overrides: Partial<LogRotationConfig> = {}): LogRotationConfig {
  return { maxTotalBytes: 0, maxFileBytes: 0, maxAgeMs: 0, minEntries: 0, ...overrides };
}

// ─── selectEntriesToPrune ───

describe('selectEntriesToPrune', () => {
  it('returns empty array when entries.length <= minEntries', () => {
    const old = Date.now() - 9999999;
    const entries = [entry('a', old), entry('b', old + 1)];
    expect(selectEntriesToPrune(entries, cfg({ minEntries: 5 }))).toEqual([]);
  });

  it('returns empty array for empty entries', () => {
    expect(selectEntriesToPrune([], cfg())).toEqual([]);
  });

  it('evicts only entries older than maxAgeMs', () => {
    const now = Date.now();
    const maxAgeMs = 10_000;
    const cutoff = now - maxAgeMs;

    // Two entries beyond cutoff, two entries within retention
    const entries = [
      entry('old1', cutoff - 5000),
      entry('new1', now),
      entry('old2', cutoff - 1),
      entry('new2', now - 100),
    ];

    const result = selectEntriesToPrune(entries, cfg({ maxAgeMs, minEntries: 0 }));

    expect(result).toContain('old1');
    expect(result).toContain('old2');
    expect(result).not.toContain('new1');
    expect(result).not.toContain('new2');
  });

  it('evicts oldest entries first when total size exceeds maxTotalBytes', () => {
    // 3 entries of roughly equal size (msg = 3 chars → ~203 bytes each)
    // Total ~609 bytes, maxTotalBytes = 300 → oldest 2 must go
    const now = Date.now();
    const entries = [
      entry('a', now - 3000),
      entry('b', now - 2000),
      entry('c', now - 1000),
    ];

    const result = selectEntriesToPrune(entries, cfg({ maxTotalBytes: 300, minEntries: 0 }));

    expect(result).toContain('a');
    expect(result).toContain('b');
    expect(result).not.toContain('c');
  });

  it('runs age eviction before size eviction', () => {
    const now = Date.now();
    const maxAgeMs = 10_000;
    const cutoff = now - maxAgeMs;

    // 2 entries beyond age cutoff, 3 recent entries with total size over limit
    const entries = [
      entry('old1', cutoff - 1000),
      entry('old2', cutoff - 2000),
      entry('recent1', now),
      entry('recent2', now - 100),
      entry('recent3', now - 200),
    ];

    // maxTotalBytes = 400 means ~2 recent entries need eviction
    const result = selectEntriesToPrune(entries, cfg({ maxAgeMs, maxTotalBytes: 400, minEntries: 0 }));

    // Age candidates removed
    expect(result).toContain('old1');
    expect(result).toContain('old2');
    // Size candidates removed (oldest remaining entries go first)
    // recent3 (now-200) is oldest remaining after age → removed first
    // recent2 (now-100) is next oldest → removed second
    expect(result).toContain('recent3');
    expect(result).toContain('recent2');
    // Newest entry stays
    expect(result).not.toContain('recent1');
  });

  it('respects minEntries guard and never drops below the floor', () => {
    const now = Date.now();
    const maxAgeMs = 10_000;
    const cutoff = now - maxAgeMs;

    // 10 entries: 6 beyond age cutoff + 4 recent but large
    const entries: StoredAuditEntry[] = [];
    for (let i = 0; i < 6; i++) {
      entries.push(entry(`old${i}`, cutoff - i * 1000));
    }
    for (let i = 0; i < 4; i++) {
      entries.push(entry(`recent${i}`, now));
    }

    const minEntries = 4;
    const result = selectEntriesToPrune(entries, cfg({ maxAgeMs, maxTotalBytes: 1, minEntries }));

    // Remaining count must never drop below minEntries
    const remaining = entries.length - result.length;
    expect(remaining).toBeGreaterThanOrEqual(minEntries);

    // With 10 entries and minEntries=4, at most 6 can be removed
    expect(result.length).toBeLessThanOrEqual(entries.length - minEntries);
  });
});

// ─── estimateEntrySize ───

describe('estimateEntrySize', () => {
  it('includes message text length in the estimate', () => {
    const short = entry('a', 0, 'abc');
    const long = entry('b', 0, 'abcdefghij');
    expect(estimateEntrySize(long) - estimateEntrySize(short)).toBe(7); // 10 - 3
  });
});

// ─── Config constants ───

describe('rotation config defaults', () => {
  it('DEFAULT_ROTATION has expected values', () => {
    expect(DEFAULT_ROTATION.maxTotalBytes).toBe(100 * 1024 * 1024);
    expect(DEFAULT_ROTATION.maxFileBytes).toBe(16 * 1024 * 1024);
    expect(DEFAULT_ROTATION.maxAgeMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(DEFAULT_ROTATION.minEntries).toBe(1000);
  });

  it('PRODUCTION_ROTATION has expected values', () => {
    expect(PRODUCTION_ROTATION.maxTotalBytes).toBe(4 * 1024 * 1024 * 1024);
    expect(PRODUCTION_ROTATION.maxFileBytes).toBe(512 * 1024 * 1024);
    expect(PRODUCTION_ROTATION.maxAgeMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(PRODUCTION_ROTATION.minEntries).toBe(10000);
  });
});
