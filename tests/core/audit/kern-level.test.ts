import { describe, it, expect } from 'vitest';
import {
  KernLevel, kernLevelName,
  AuditFacility,
  encodePriority, decodePriority,
  resolveFacility, facilityName,
} from '../../../src/core/audit/kern-level.ts';

describe('KernLevel', () => {
  it('defines 8 levels (0-7)', () => {
    expect(KernLevel.EMERG).toBe(0);
    expect(KernLevel.ALERT).toBe(1);
    expect(KernLevel.CRIT).toBe(2);
    expect(KernLevel.ERR).toBe(3);
    expect(KernLevel.WARNING).toBe(4);
    expect(KernLevel.NOTICE).toBe(5);
    expect(KernLevel.INFO).toBe(6);
    expect(KernLevel.DEBUG).toBe(7);
  });

  it('kernLevelName maps level to name', () => {
    expect(kernLevelName(KernLevel.EMERG)).toBe('EMERG');
    expect(kernLevelName(KernLevel.ERR)).toBe('ERR');
    expect(kernLevelName(KernLevel.DEBUG)).toBe('DEBUG');
  });

  it('kernLevelName produces fallback for unknown level', () => {
    const name = kernLevelName(99 as KernLevel);
    expect(name).toContain('99');
  });
});

// ═══════════════════════════════════════════════════════════════
// Priority encode/decode (ISSUE-00009)
// ═══════════════════════════════════════════════════════════════

describe('encodePriority', () => {
  it('encode(0,0) → 0', () => {
    expect(encodePriority(AuditFacility.KERN, KernLevel.EMERG)).toBe(0);
  });
  it('encode(AUTH, NOTICE) → 29 (3*8+5)', () => {
    expect(encodePriority(AuditFacility.AUTH, KernLevel.NOTICE)).toBe(29);
  });
  it('encode(LOCAL7, DEBUG) → 191 (max)', () => {
    expect(encodePriority(AuditFacility.LOCAL7, KernLevel.DEBUG)).toBe(191);
  });
  it('encode rounds to facility * 8 + level', () => {
    expect(encodePriority(AuditFacility.POD, KernLevel.WARNING)).toBe(12);
    expect(encodePriority(AuditFacility.LOCAL0, KernLevel.CRIT)).toBe(130);
  });

  it('throws on facility > 23', () => {
    expect(() => encodePriority(24, 0)).toThrow(RangeError);
  });
  it('throws on level > 7', () => {
    expect(() => encodePriority(0, 8)).toThrow(RangeError);
  });
  it('throws on negative facility', () => {
    expect(() => encodePriority(-1, 0)).toThrow(RangeError);
  });
  it('throws on negative level', () => {
    expect(() => encodePriority(0, -1)).toThrow(RangeError);
  });
  it('throws on non-integer facility', () => {
    expect(() => encodePriority(1.5, 0)).toThrow(RangeError);
  });
});

describe('decodePriority', () => {
  it('decode(29) → { facility: 3, level: 5 }', () => {
    const { facility, level } = decodePriority(29);
    expect(facility).toBe(AuditFacility.AUTH);
    expect(level).toBe(KernLevel.NOTICE);
  });
  it('decode(0) → { facility: 0, level: 0 }', () => {
    const { facility, level } = decodePriority(0);
    expect(facility).toBe(AuditFacility.KERN);
    expect(level).toBe(KernLevel.EMERG);
  });
  it('decode(191) → { facility: 23, level: 7 }', () => {
    const { facility, level } = decodePriority(191);
    expect(facility).toBe(AuditFacility.LOCAL7);
    expect(level).toBe(KernLevel.DEBUG);
  });
});

describe('encode/decode round-trip — 24×8=192 组合穷举', () => {
  for (let f = 0; f <= 23; f++) {
    for (let l = 0; l <= 7; l++) {
      it(`round-trip f=${f} l=${l}`, () => {
        const { facility, level } = decodePriority(encodePriority(f, l));
        expect(facility).toBe(f);
        expect(level).toBe(l);
      });
    }
  }
});

describe('resolveFacility', () => {
  it('known names', () => {
    expect(resolveFacility('kern')).toBe(AuditFacility.KERN);
    expect(resolveFacility('auth')).toBe(AuditFacility.AUTH);
    expect(resolveFacility('volume')).toBe(AuditFacility.VOLUME);
  });
  it('aliases', () => {
    expect(resolveFacility('system')).toBe(AuditFacility.KERN);
    expect(resolveFacility('pod-service')).toBe(AuditFacility.POD);
  });
  it('case-insensitive', () => {
    expect(resolveFacility('KERN')).toBe(AuditFacility.KERN);
    expect(resolveFacility('Auth')).toBe(AuditFacility.AUTH);
  });
  it('unknown → LOCAL0', () => {
    expect(resolveFacility('nonexistent')).toBe(AuditFacility.LOCAL0);
  });
});

describe('facilityName', () => {
  it('known facilities', () => {
    expect(facilityName(AuditFacility.KERN)).toBe('kern');
    expect(facilityName(AuditFacility.LOCAL0)).toBe('local0');
  });
  it('fallback for unrecognized code', () => {
    expect(facilityName(99 as AuditFacility)).toBe('local83');
  });
});
