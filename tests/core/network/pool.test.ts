import { describe, it, expect, beforeEach } from 'vitest';
import { SubnetPool } from '../../../src/core/network/pool.ts';
import { StubAtomicStore } from './stub-atomic.ts';

function createPool(supernet = '10.2.0.0/16', prefixLen = 24) {
  const atomic = new StubAtomicStore();
  const pool = new SubnetPool(atomic as any, supernet, prefixLen);
  return { pool, atomic };
}

describe('SubnetPool', () => {
  it('allocates first subnet', async () => {
    const { pool } = createPool();
    const cidr = await pool.allocate('tenant-1');
    expect(cidr).toBe('10.2.0.0/24');
  });

  it('allocates sequential subnets', async () => {
    const { pool } = createPool();
    const a = await pool.allocate('t1');
    const b = await pool.allocate('t2');
    const c = await pool.allocate('t3');
    expect(a).toBe('10.2.0.0/24');
    expect(b).toBe('10.2.1.0/24');
    expect(c).toBe('10.2.2.0/24');
  });

  it('reuses released subnet', async () => {
    const { pool } = createPool();
    await pool.allocate('t1');
    const cidr2 = await pool.allocate('t2');
    await pool.release(cidr2);
    const cidr3 = await pool.allocate('t3');
    // Should reuse the released slot
    expect(cidr3).toBe(cidr2);
  });

  it('tracks allocations in status', async () => {
    const { pool } = createPool();
    await pool.allocate('t1');
    await pool.allocate('t2');
    const status = await pool.status();
    expect(status.used).toBe(2);
    expect(status.total).toBe(256); // /16 → /24 = 256 subnets
    expect(status.allocations[0]!.tenantId).toBe('t1');
    expect(status.allocations[1]!.tenantId).toBe('t2');
  });

  it('throws when pool is exhausted', async () => {
    const { pool } = createPool('10.0.0.0/30', 32); // only 4 subnets
    await pool.allocate('a');
    await pool.allocate('b');
    await pool.allocate('c');
    await pool.allocate('d');
    await expect(pool.allocate('e')).rejects.toThrow('exhausted');
  });

  it('rejects release outside supernet', async () => {
    const { pool } = createPool('10.2.0.0/16');
    await expect(pool.release('192.168.1.0/24')).rejects.toThrow('not within');
  });
});
