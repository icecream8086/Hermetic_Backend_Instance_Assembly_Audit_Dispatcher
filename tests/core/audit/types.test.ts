import { describe, it, expect } from 'vitest';
import {
  encodeCursor,
  decodeCursor,
  cursorFromEntry,
  xorHash,
} from '../../../src/core/audit/types.ts';
import { KernLevel } from '../../../src/core/audit/kern-level.ts';
import type { LogCursor, StoredAuditEntry } from '../../../src/core/audit/types.ts';

describe('xorHash', () => {
  const base = { s: 'abc', i: 42, b: 'boot-1', m: 12345, t: 67890 };

  it('returns 8-char hex string', () => {
    const hash = xorHash(base);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('same inputs produce same hash', () => {
    expect(xorHash(base)).toBe(xorHash(base));
  });

  it('changing s changes the hash', () => {
    const changed = { s: 'xyz', i: 42, b: 'boot-1', m: 12345, t: 67890 };
    expect(xorHash(base)).not.toBe(xorHash(changed));
  });

  it('changing i changes the hash', () => {
    const changed = { s: 'abc', i: 99, b: 'boot-1', m: 12345, t: 67890 };
    expect(xorHash(base)).not.toBe(xorHash(changed));
  });

  it('changing b changes the hash', () => {
    const changed = { s: 'abc', i: 42, b: 'boot-2', m: 12345, t: 67890 };
    expect(xorHash(base)).not.toBe(xorHash(changed));
  });

  it('changing m changes the hash', () => {
    const changed = { s: 'abc', i: 42, b: 'boot-1', m: 99999, t: 67890 };
    expect(xorHash(base)).not.toBe(xorHash(changed));
  });

  it('changing t changes the hash', () => {
    const changed = { s: 'abc', i: 42, b: 'boot-1', m: 12345, t: 11111 };
    expect(xorHash(base)).not.toBe(xorHash(changed));
  });
});

describe('encodeCursor / decodeCursor round-trip', () => {
  function cursorWith(overrides: Partial<LogCursor>): LogCursor {
    const c: LogCursor = { s: 'm', i: 1, b: 'b', m: 2, t: 3, x: '', ...overrides };
    c.x = xorHash(c);
    return c;
  }

  it('round-trips normal values', () => {
    const c = cursorWith({ s: 'machine-1', i: 42, b: 'boot-1', m: 12345, t: 67890 });
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('round-trips zero / empty values', () => {
    const c = cursorWith({ s: '', i: 0, b: '', m: 0, t: 0 });
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('round-trips large numbers', () => {
    const c = cursorWith({
      s: 'big-machine', i: 2_147_483_647, b: 'long-boot-id',
      m: 9_007_199_254_740_991, t: 1_700_000_000_000,
    });
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });
});

describe('encodeCursor format', () => {
  it('includes all 6 field prefixes', () => {
    const c: LogCursor = { s: 'm', i: 1, b: 'b', m: 2, t: 3, x: '' };
    c.x = xorHash(c);
    const enc = encodeCursor(c);
    expect(enc).toContain('s=');
    expect(enc).toContain('i=');
    expect(enc).toContain('b=');
    expect(enc).toContain('m=');
    expect(enc).toContain('t=');
    expect(enc).toContain('x=');
  });
});

describe('decodeCursor tolerance', () => {
  it('produces NaN for numeric fields on empty string', () => {
    const d = decodeCursor('');
    expect(d).not.toBeNull();
    expect(d!.i).toBeNaN();
    expect(d!.m).toBeNaN();
    expect(d!.t).toBeNaN();
  });

  it('produces NaN for numeric fields on garbage', () => {
    const d = decodeCursor('not-a-cursor');
    expect(d).not.toBeNull();
    expect(d!.i).toBeNaN();
    expect(d!.m).toBeNaN();
    expect(d!.t).toBeNaN();
  });

  it('produces NaN for missing numeric fields', () => {
    const d = decodeCursor('s=foo;i=1');
    expect(d).not.toBeNull();
    expect(d!.m).toBeNaN();
    expect(d!.t).toBeNaN();
  });
});

describe('cursorFromEntry', () => {
  it('produces a cursor that round-trips through encode/decode', () => {
    const entry: StoredAuditEntry = {
      id: 'entry-1',
      timestamp: 1_700_000_000_000,
      level: KernLevel.INFO,
      facility: 'user',
      message: 'test entry',
    };
    const cursor = cursorFromEntry(entry, 'boot-abc', 99, 'machine-hash');

    const decoded = decodeCursor(encodeCursor(cursor));
    expect(decoded).not.toBeNull();
    expect(decoded!.s).toBe('machine-hash');
    expect(decoded!.i).toBe(99);
    expect(decoded!.b).toBe('boot-abc');
    expect(decoded!.m).toBeGreaterThan(0);
    expect(decoded!.t).toBe(1_700_000_000_000);
    expect(decoded!.x).toBe(cursor.x);
  });
});
