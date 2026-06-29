/**
 * Subnet pool — manages allocation and release of CIDR subnets
 * with overlap detection and OCC persistence.
 *
 * Strategy: first-fit within a configurable supernet.
 * Allocates subnets sequentially from the supernet, tracks
 * allocations by tenant ID in IAtomicStore.
 *
 * Usage:
 *   const pool = new SubnetPool(atomic, '10.2.0.0/16');
 *   const subnet = await pool.allocate('tenant-1', 24);
 *   // → "10.2.0.0/24"
 *   await pool.release('10.2.0.0/24');
 */

import type { IAtomicStore } from '../store/interfaces.ts';
import { parseCidr, formatCidr, contains, subnets } from './cidr.ts';

/** A persisted allocation record. */
export interface SubnetAllocation {
  readonly cidr: string;
  readonly tenantId: string;
  readonly allocatedAt: number;
}

/** Pool status snapshot. */
export interface PoolStatus {
  readonly supernet: string;
  readonly total: number;
  readonly used: number;
  readonly allocations: readonly SubnetAllocation[];
}

const ALLOC_PREFIX = 'net:alloc:';
const INDEX_KEY = 'net:pool:index';

export class SubnetPool {
  readonly #atomic: IAtomicStore;
  readonly #supernet: ReturnType<typeof parseCidr>;
  readonly #prefixLen: number; // allocation size (e.g. 24 for /24)

  /**
   * @param atomic    - IAtomicStore for persistence
   * @param supernet  - e.g. "10.2.0.0/16"
   * @param prefixLen - allocation prefix length (default 24)
   */
  public constructor(atomic: IAtomicStore, supernet: string, prefixLen = 24) {
    this.#atomic = atomic;
    this.#supernet = parseCidr(supernet);
    this.#prefixLen = prefixLen;
  }

  /**
   * Allocate a subnet for a tenant.
   * Returns the CIDR string on success.
   * Throws if no free subnets remain.
   */
  public async allocate(tenantId: string): Promise<string> {
    const allocations = await this.#listAllocations();

    // Build set of already-allocated CIDRs
    const used = new Set(allocations.map(a => a.cidr));

    // First-fit: scan supernet for first unused subnet
    for (const candidate of subnets(this.#supernet, this.#prefixLen)) {
      const cidrStr = formatCidr(candidate);
      if (used.has(cidrStr)) continue;

      // Persist allocation with OCC
      const record: SubnetAllocation = {
        cidr: cidrStr,
        tenantId,
        allocatedAt: Date.now(),
      };

      const allocKey = ALLOC_PREFIX + cidrStr.replace(/\//g, '_');
      const written = await this.#atomic.set(allocKey, record, null);
      if (!written) continue; // race lost, try next

      // Add to index
      const idxEntry = await this.#atomic.get<string[]>(INDEX_KEY);
      await this.#atomic.set(INDEX_KEY, [...(idxEntry?.value ?? []), cidrStr], idxEntry?.version ?? null);

      return cidrStr;
    }

    throw new Error(`Subnet pool exhausted: no free /${String(this.#prefixLen)} in ${formatCidr(this.#supernet)}`);
  }

  /**
   * Release a previously allocated subnet back to the pool.
   */
  public async release(cidr: string): Promise<void> {
    const block = parseCidr(cidr);
    if (!contains(this.#supernet, block)) {
      throw new Error(`CIDR ${cidr} is not within the pool supernet ${formatCidr(this.#supernet)}`);
    }

    const allocKey = ALLOC_PREFIX + cidr.replace(/\//g, '_');
    const entry = await this.#atomic.get<SubnetAllocation>(allocKey);
    if (!entry) return; // not allocated

    // Remove allocation record
    await this.#atomic.set(allocKey, null, entry.version);

    // Remove from index
    const idxEntry = await this.#atomic.get<string[]>(INDEX_KEY);
    if (idxEntry) {
      await this.#atomic.set(INDEX_KEY, idxEntry.value.filter(c => c !== cidr), idxEntry.version);
    }
  }

  /**
   * Get pool status: supernet, total/used counts, all allocations.
   */
  public async status(): Promise<PoolStatus> {
    const allocations = await this.#listAllocations();
    return {
      supernet: formatCidr(this.#supernet),
      total: 2 ** (this.#prefixLen - this.#supernet.bits),
      used: allocations.length,
      allocations,
    };
  }

  /**
   * List all current allocations.
   */
  async #listAllocations(): Promise<SubnetAllocation[]> {
    const idxEntry = await this.#atomic.get<string[]>(INDEX_KEY);
    if (!idxEntry) return [];

    const results: SubnetAllocation[] = [];
    for (const cidr of idxEntry.value) {
      const allocKey = ALLOC_PREFIX + cidr.replace(/\//g, '_');
      const entry = await this.#atomic.get<SubnetAllocation>(allocKey);
      if (entry) results.push(entry.value);
    }
    return results;
  }
}
