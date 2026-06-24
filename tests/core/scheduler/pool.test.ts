import { describe, it, expect } from 'vitest';
import {
  createPool,
  claimSlot,
  releaseSlot,
  hasOpenSlots,
  openSlots,
  DEFAULT_POOL,
} from '../../../src/core/scheduler/pool.ts';

describe('Pool', () => {
  describe('createPool', () => {
    it('creates a pool with given slots', () => {
      const pool = createPool('test', 5);
      expect(pool.name).toBe('test');
      expect(pool.slots).toBe(5);
      expect(pool.occupiedSlots).toBe(0);
    });

    it('throws for 0 slots', () => {
      expect(() => createPool('bad', 0)).toThrow();
    });
  });

  describe('openSlots / hasOpenSlots', () => {
    it('returns total slots when none occupied', () => {
      const pool = createPool('test', 3);
      expect(openSlots(pool)).toBe(3);
      expect(hasOpenSlots(pool)).toBe(true);
    });

    it('returns difference when some occupied', () => {
      const pool = createPool('test', 3);
      pool.occupiedSlots = 2;
      expect(openSlots(pool)).toBe(1);
      expect(hasOpenSlots(pool)).toBe(true);
    });

    it('returns 0 when full', () => {
      const pool = createPool('test', 3);
      pool.occupiedSlots = 3;
      expect(openSlots(pool)).toBe(0);
      expect(hasOpenSlots(pool)).toBe(false);
    });
  });

  describe('claimSlot', () => {
    it('increments occupied count', () => {
      const pool = createPool('test', 2);
      const claimed = claimSlot(pool);
      expect(claimed).not.toBeNull();
      expect(claimed!.occupiedSlots).toBe(1);
    });

    it('returns null when pool is full', () => {
      const pool = createPool('test', 1);
      pool.occupiedSlots = 1;
      expect(claimSlot(pool)).toBeNull();
    });
  });

  describe('releaseSlot', () => {
    it('decrements occupied count', () => {
      const pool = createPool('test', 3);
      pool.occupiedSlots = 2;
      const released = releaseSlot(pool);
      expect(released.occupiedSlots).toBe(1);
    });

    it('never goes below 0', () => {
      const pool = createPool('test', 1);
      pool.occupiedSlots = 0;
      const released = releaseSlot(pool);
      expect(released.occupiedSlots).toBe(0);
    });
  });

  describe('DEFAULT_POOL', () => {
    it('has 128 slots', () => {
      expect(DEFAULT_POOL.slots).toBe(128);
      expect(DEFAULT_POOL.name).toBe('default_pool');
    });
  });
});
