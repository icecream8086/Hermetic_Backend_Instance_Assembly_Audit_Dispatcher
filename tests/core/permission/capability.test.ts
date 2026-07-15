import { describe, it, expect } from 'vitest';
import {
  Cap,
  hasCapability,
  addCapability,
  removeCapability,
  formatCapabilities,
  parseCapabilities,
  actionToCapability,
} from '../../../src/core/permission/capability.ts';

const SINGLE_BITS: number[] = [
  Cap.POD_CREATE,
  Cap.POD_DELETE,
  Cap.POD_UPDATE,
  Cap.POD_EXEC,
  Cap.POD_ADMIN,
  Cap.IMAGE_PULL,
  Cap.IMAGE_DELETE,
  Cap.IMAGE_COMMIT,
  Cap.VOLUME_MOUNT,
  Cap.VOLUME_CREATE,
  Cap.VOLUME_DELETE,
  Cap.NETWORK_BIND,
  Cap.NETWORK_ADMIN,
  Cap.USER_CREATE,
  Cap.USER_DELETE,
  Cap.USER_ADMIN,
  Cap.SYS_AUDIT_READ,
  Cap.SYS_AUDIT_WRITE,
  Cap.SYS_CONFIG,
];

const COMPOSITE_SETS: number[] = [
  Cap.POD_FULL,
  Cap.IMAGE_FULL,
  Cap.VOLUME_FULL,
  Cap.NETWORK_FULL,
  Cap.USER_FULL,
  Cap.SYS_FULL,
  Cap.ALL,
];

// ═══════════════════════════════════════════════════════════
// hasCapability
// ═══════════════════════════════════════════════════════════

describe('hasCapability', () => {
  it('Cap.ALL has every single bit', () => {
    for (const bit of SINGLE_BITS) {
      expect(hasCapability(Cap.ALL, bit)).toBe(true);
    }
  });

  it('Cap.ALL has every composite set', () => {
    for (const set of COMPOSITE_SETS) {
      expect(hasCapability(Cap.ALL, set)).toBe(true);
    }
  });

  it('Cap.ALL has 0', () => {
    expect(hasCapability(Cap.ALL, 0)).toBe(true);
  });

  it('hasCapability(0, nonZeroReq) == false for various non-zero req', () => {
    for (const req of [...SINGLE_BITS, ...COMPOSITE_SETS]) {
      expect(hasCapability(0, req)).toBe(false);
    }
  });

  it('matches (caps & required) === required for mixed values', () => {
    const testCases: [number, number][] = [
      [Cap.POD_CREATE | Cap.IMAGE_PULL, Cap.POD_CREATE],
      [Cap.POD_CREATE | Cap.IMAGE_PULL, Cap.IMAGE_PULL],
      [Cap.POD_CREATE | Cap.IMAGE_PULL, Cap.POD_CREATE | Cap.IMAGE_PULL],
      [Cap.POD_CREATE | Cap.IMAGE_PULL, Cap.POD_DELETE],
      [Cap.POD_CREATE | Cap.IMAGE_PULL, Cap.POD_CREATE | Cap.IMAGE_DELETE],
      [Cap.POD_FULL, Cap.POD_CREATE | Cap.POD_EXEC],
      [Cap.POD_FULL, Cap.POD_CREATE | Cap.POD_ADMIN],
      [Cap.POD_CREATE, 0],
    ];
    for (const [caps, req] of testCases) {
      expect(hasCapability(caps, req)).toBe((caps & req) === req);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// addCapability
// ═══════════════════════════════════════════════════════════

describe('addCapability', () => {
  it('addCapability(c, 0) == c (identity)', () => {
    for (const c of [...SINGLE_BITS, ...COMPOSITE_SETS, 0]) {
      expect(addCapability(c, 0)).toBe(c);
    }
  });

  it('addCapability(addCapability(c, a), b) == addCapability(c, a | b) (associativity)', () => {
    const values: number[] = [
      0,
      Cap.POD_CREATE,
      Cap.POD_DELETE,
      Cap.IMAGE_PULL,
      Cap.VOLUME_MOUNT,
      Cap.NETWORK_BIND,
      Cap.SYS_CONFIG,
      Cap.POD_FULL,
      Cap.IMAGE_FULL,
      Cap.VOLUME_FULL,
      Cap.ALL,
    ];
    for (const c of values) {
      for (const a of values) {
        for (const b of values) {
          expect(addCapability(addCapability(c, a), b)).toBe(addCapability(c, a | b));
        }
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════
// removeCapability
// ═══════════════════════════════════════════════════════════

describe('removeCapability', () => {
  it('removing a set bit clears it', () => {
    const mask = Cap.POD_CREATE | Cap.POD_DELETE | Cap.POD_UPDATE;
    expect(removeCapability(mask, Cap.POD_DELETE)).toBe(Cap.POD_CREATE | Cap.POD_UPDATE);
    expect(removeCapability(mask, Cap.POD_CREATE)).toBe(Cap.POD_DELETE | Cap.POD_UPDATE);
    expect(removeCapability(mask, Cap.POD_UPDATE)).toBe(Cap.POD_CREATE | Cap.POD_DELETE);
    expect(removeCapability(mask, Cap.POD_CREATE | Cap.POD_DELETE)).toBe(Cap.POD_UPDATE);
  });

  it('removing a bit not set is a no-op', () => {
    const mask = Cap.POD_CREATE | Cap.IMAGE_PULL;
    expect(removeCapability(mask, Cap.POD_DELETE)).toBe(mask);
    expect(removeCapability(mask, Cap.POD_UPDATE | Cap.IMAGE_DELETE)).toBe(mask);
  });

  it('removing 0 is a no-op', () => {
    const mask = Cap.POD_FULL | Cap.IMAGE_FULL;
    expect(removeCapability(mask, 0)).toBe(mask);
  });
});

// ═══════════════════════════════════════════════════════════
// actionToCapability
// ═══════════════════════════════════════════════════════════

describe('actionToCapability', () => {
  const nonZeroActions = ['create', 'delete', 'update', 'execute', 'admin', '*', 'pull', 'commit', 'mount', 'bind'];

  const zeroActions = ['read', 'list', 'unknown'];

  it('maps expected actions to their correct specific capabilities', () => {
    expect(actionToCapability('create')).toBe(Cap.POD_CREATE);
    expect(actionToCapability('delete')).toBe(Cap.POD_DELETE);
    expect(actionToCapability('update')).toBe(Cap.POD_UPDATE);
    expect(actionToCapability('execute')).toBe(Cap.POD_EXEC);
    expect(actionToCapability('admin')).toBe(Cap.POD_ADMIN);
    expect(actionToCapability('*')).toBe(Cap.POD_ADMIN);
    expect(actionToCapability('pull')).toBe(Cap.IMAGE_PULL);
    expect(actionToCapability('commit')).toBe(Cap.IMAGE_COMMIT);
    expect(actionToCapability('mount')).toBe(Cap.VOLUME_MOUNT);
    expect(actionToCapability('bind')).toBe(Cap.NETWORK_BIND);
  });

  it('maps read, list, unknown to zero capability', () => {
    for (const action of zeroActions) {
      expect(actionToCapability(action)).toBe(0);
    }
  });

  it('no returned capability value has bit >= 19', () => {
    const maxBit = 1 << 19;
    for (const action of [...nonZeroActions, ...zeroActions]) {
      expect(actionToCapability(action)).toBeLessThan(maxBit);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// formatCapabilities / parseCapabilities round-trip
// ═══════════════════════════════════════════════════════════

describe('formatCapabilities / parseCapabilities round-trip', () => {
  const roundTripValues: number[] = [
    0,
    Cap.POD_CREATE,
    Cap.POD_FULL,
    Cap.IMAGE_PULL,
    Cap.POD_CREATE | Cap.IMAGE_PULL | Cap.NETWORK_BIND | Cap.SYS_AUDIT_READ,
    Cap.POD_CREATE | Cap.POD_DELETE,
    Cap.ALL,
    Cap.VOLUME_FULL | Cap.USER_FULL,
  ];

  for (const caps of roundTripValues) {
    it(`round-trips 0x${caps.toString(16)} (${caps})`, () => {
      const formatted = formatCapabilities(caps);
      const parsed = parseCapabilities(formatted.join(','));
      expect(parsed).toBe(caps);
    });
  }
});
