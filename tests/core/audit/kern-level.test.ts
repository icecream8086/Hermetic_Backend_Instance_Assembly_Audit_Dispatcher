import { describe, it, expect } from 'vitest';
import { KernLevel, kernLevelName } from '../../../src/core/audit/kern-level.ts';

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
