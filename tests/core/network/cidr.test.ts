import { describe, it, expect } from 'vitest';
import { parseCidr, formatCidr, contains, subnets, nextSubnet, hostCount, broadcast, cidrKey } from '../../../src/core/network/cidr.ts';

describe('CIDR utilities', () => {
  it('parses and formats CIDR', () => {
    const block = parseCidr('10.2.3.0/24');
    expect(block.ip).toBe(0x0A020300);
    expect(block.bits).toBe(24);
    expect(formatCidr(block)).toBe('10.2.3.0/24');
  });

  it('handles /16', () => {
    const block = parseCidr('192.168.0.0/16');
    const octet1 = 192, octet2 = 168, octet3 = 0, octet4 = 0;
    const ip = ((octet1 << 24) | (octet2 << 16) | (octet3 << 8) | octet4) >>> 0;
    expect(block.ip).toBe(3232235520);
    expect(block.ip).toBe(ip);
    expect(block.bits).toBe(16);
    expect(formatCidr(block)).toBe('192.168.0.0/16');
  });

  it('handles /32', () => {
    const block = parseCidr('10.0.0.1/32');
    expect(block.ip).toBe(0x0A000001);
  });

  it('contains checks inner subnet', () => {
    const outer = parseCidr('10.2.0.0/16');
    const inner = parseCidr('10.2.3.0/24');
    expect(contains(outer, inner)).toBe(true);
  });

  it('rejects non-contained subnet', () => {
    const outer = parseCidr('10.2.0.0/16');
    const outside = parseCidr('10.3.0.0/24');
    expect(contains(outer, outside)).toBe(false);
  });

  it('rejects equal or longer prefix in contains', () => {
    const smaller = parseCidr('10.2.3.0/24');
    const larger = parseCidr('10.2.0.0/16');
    expect(contains(smaller, larger)).toBe(false);
  });

  it('iterates subnets', () => {
    const parent = parseCidr('10.0.0.0/30');
    const result = [...subnets(parent, 32)].map(formatCidr);
    // /30 has 4 addresses, each /32 is one addr
    expect(result).toEqual([
      '10.0.0.0/32',
      '10.0.0.1/32',
      '10.0.0.2/32',
      '10.0.0.3/32',
    ]);
  });

  it('nextSubnet returns sequential block', () => {
    const parent = parseCidr('10.0.0.0/24');
    const current = parseCidr('10.0.0.0/25');
    const next = nextSubnet(parent, current);
    expect(next).not.toBeNull();
    expect(formatCidr(next!)).toBe('10.0.0.128/25');
  });

  it('nextSubnet returns null at end', () => {
    const parent = parseCidr('10.0.0.0/25');
    const last = parseCidr('10.0.0.0/25');
    const next = nextSubnet(parent, last);
    expect(next).toBeNull();
  });

  it('hostCount excludes network + broadcast', () => {
    expect(hostCount(parseCidr('10.0.0.0/24'))).toBe(254);
    expect(hostCount(parseCidr('10.0.0.0/31'))).toBe(2); // ptp
    expect(hostCount(parseCidr('10.0.0.0/32'))).toBe(1);
  });
});

describe('broadcast', () => {
  it('broadcast of 10.0.0.0/24 is 10.0.0.255', () => {
    expect(formatCidr({ ip: broadcast(parseCidr('10.0.0.0/24')), bits: 32 })).toBe('10.0.0.255/32');
  });
});

describe('format(parse(s)) == s round-trip', () => {
  it.each([
    '10.0.0.0/24',
    '192.168.0.0/16',
    '10.2.3.4/32',
  ])('%s', (input) => {
    expect(formatCidr(parseCidr(input))).toBe(input);
  });
});

describe('subnets disjoint and union', () => {
  it('subnets(10.0.0.0/24, 26) yields 4 disjoint subnets contained in parent', () => {
    const parent = parseCidr('10.0.0.0/24');
    const parts = [...subnets(parent, 26)];
    expect(parts).toHaveLength(4);
    expect(formatCidr(parts[0])).toBe('10.0.0.0/26');
    expect(formatCidr(parts[1])).toBe('10.0.0.64/26');
    expect(formatCidr(parts[2])).toBe('10.0.0.128/26');
    expect(formatCidr(parts[3])).toBe('10.0.0.192/26');
    // each contained in parent
    for (const part of parts) {
      expect(contains(parent, part)).toBe(true);
    }
    // pairwise disjoint
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        expect(contains(parts[i], parts[j])).toBe(false);
        expect(contains(parts[j], parts[i])).toBe(false);
      }
    }
  });
});

describe('contains() issue spec examples', () => {
  it('/8 contains /24', () => {
    expect(contains(parseCidr('10.0.0.0/8'), parseCidr('10.0.0.0/24'))).toBe(true);
  });
  it('/24 does not contain /8', () => {
    expect(contains(parseCidr('10.0.0.0/24'), parseCidr('10.0.0.0/8'))).toBe(false);
  });
});
