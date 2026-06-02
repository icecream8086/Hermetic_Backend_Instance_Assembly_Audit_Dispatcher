/**
 * CIDR utilities for subnet pool management.
 *
 * Pure functions — no I/O, no state.
 */

export interface CidrBlock {
  readonly ip: number;  // network address as uint32 (big-endian)
  readonly bits: number; // prefix length (1-32)
}

/** Parse "10.2.3.0/24" → { ip: 0x0A020300, bits: 24 }. */
export function parseCidr(s: string): CidrBlock {
  const [addr, bitsStr] = s.split('/');
  if (!addr || !bitsStr) throw new Error(`Invalid CIDR: ${s}`);
  const octets = addr.split('.').map(Number);
  if (octets.length !== 4 || octets.some(o => isNaN(o) || o < 0 || o > 255)) {
    throw new Error(`Invalid IPv4 address: ${addr}`);
  }
  const bits = parseInt(bitsStr, 10);
  if (isNaN(bits) || bits < 1 || bits > 32) throw new Error(`Invalid prefix length: ${bits}`);
  const raw = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  // Mask to network address — >>> 0 to keep unsigned after signed 32-bit &
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { ip: (raw & mask) >>> 0, bits };
}

/** Format { ip: 0x0A020300, bits: 24 } → "10.2.3.0/24". */
export function formatCidr(block: CidrBlock): string {
  const ip = block.ip >>> 0;
  const o1 = (ip >>> 24) & 0xFF;
  const o2 = (ip >>> 16) & 0xFF;
  const o3 = (ip >>> 8) & 0xFF;
  const o4 = ip & 0xFF;
  return `${o1}.${o2}.${o3}.${o4}/${block.bits}`;
}

/** Get the broadcast address of a CIDR block. */
export function broadcast(block: CidrBlock): number {
  const mask = block.bits === 0 ? 0 : ((~0 >>> 0) << (32 - block.bits)) >>> 0;
  return (block.ip | ~mask) >>> 0;
}

/** Get the number of host addresses in a CIDR block (0 for /32). */
export function hostCount(block: CidrBlock): number {
  if (block.bits >= 31) return 2 ** (32 - block.bits);
  return 2 ** (32 - block.bits) - 2; // subtract network + broadcast
}

/** Check if `inner` is fully contained within `outer`. */
export function contains(outer: CidrBlock, inner: CidrBlock): boolean {
  if (outer.bits > inner.bits) return false; // outer prefix must be shorter or equal
  const mask = outer.bits === 0 ? 0 : (~0 << (32 - outer.bits)) >>> 0;
  return (outer.ip & mask) === (inner.ip & mask);
}

/**
 * Iterate all subnets of `parent` with `prefixLen`.
 * Yields each subnet CIDR block.
 */
export function* subnets(parent: CidrBlock, prefixLen: number): Generator<CidrBlock> {
  if (prefixLen <= parent.bits) throw new Error(`prefixLen (${prefixLen}) must be > parent bits (${parent.bits})`);
  const step = 2 ** (32 - prefixLen);
  const end = broadcast(parent) + 1;
  for (let ip = parent.ip; ip < end; ip += step) {
    yield { ip: ip >>> 0, bits: prefixLen };
  }
}

/** Get the next sequential CIDR block after `current` within `parent`. */
export function nextSubnet(parent: CidrBlock, current: CidrBlock): CidrBlock | null {
  const step = 2 ** (32 - current.bits);
  const nextIp = (current.ip + step) >>> 0;
  const next: CidrBlock = { ip: nextIp, bits: current.bits };
  if (contains(parent, next)) return next;
  return null;
}

/** Convert CIDR block to a stable string key for storage. */
export function cidrKey(block: CidrBlock): string {
  return formatCidr(block);
}
