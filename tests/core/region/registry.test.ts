import { describe, it, expect, beforeAll } from 'vitest';
import { createRegionId, createAlibabaRegion, createAwsRegion, ALIBABA_REGIONS, AWS_REGIONS, LOCAL_REGION } from '../../../src/core/region/types';
import { RegionRegistry, getDefaultRegistry, setDefaultRegistry } from '../../../src/core/region/registry';

describe('RegionId brand type', () => {
  it('creates a RegionId from a valid string', () => {
    const r = createRegionId('cn-hangzhou');
    expect(r).toBe('cn-hangzhou');
  });

  it('throws on empty string', () => {
    expect(() => createRegionId('')).toThrow('RegionId must not be empty');
  });

  it('throws on whitespace-only string', () => {
    expect(() => createRegionId('   ')).toThrow('RegionId must not be empty');
  });

  it('accepts sentinel string "unknown"', () => {
    const r = createRegionId('unknown');
    expect(r).toBe('unknown');
  });
});

describe('AlibabaRegion validation', () => {
  it('accepts known Alibaba regions', () => {
    const r = createAlibabaRegion('cn-beijing');
    expect(r).toBe('cn-beijing');
  });

  it('rejects unknown region', () => {
    expect(() => createAlibabaRegion('mars-1')).toThrow('Invalid Alibaba region');
  });

  it('ALIBABA_REGIONS includes major regions', () => {
    expect(ALIBABA_REGIONS).toContain('cn-hangzhou');
    expect(ALIBABA_REGIONS).toContain('cn-beijing');
    expect(ALIBABA_REGIONS).toContain('us-east-1');
    expect(ALIBABA_REGIONS).toContain('eu-west-1');
  });
});

describe('AWS region validation', () => {
  it('accepts known AWS regions', () => {
    const r = createAwsRegion('us-east-1');
    expect(r).toBe('us-east-1');
  });

  it('AWS_REGIONS includes major regions', () => {
    expect(AWS_REGIONS).toContain('us-east-1');
    expect(AWS_REGIONS).toContain('eu-central-1');
    expect(AWS_REGIONS).toContain('ap-southeast-1');
  });

  it('rejects AWS-only region in createAlibabaRegion', () => {
    // 'sa-east-1' is AWS-only, not in ALIBABA_REGIONS
    expect(() => createAlibabaRegion('sa-east-1')).toThrow();
  });
});

describe('RegionRegistry', () => {
  it('returns default Alibaba endpoint for known region', () => {
    const reg = new RegionRegistry();
    const ep = reg.getEndpoint('alibaba', createRegionId('cn-hangzhou'), 'eci');
    expect(ep).toBe('eci.cn-hangzhou.aliyuncs.com');
  });

  it('returns Alibaba OSS endpoint', () => {
    const reg = new RegionRegistry();
    const ep = reg.getEndpoint('alibaba', createRegionId('cn-beijing'), 'oss');
    expect(ep).toBe('oss.cn-beijing.aliyuncs.com');
  });

  it('returns empty string for unknown provider+region', () => {
    const reg = new RegionRegistry();
    const ep = reg.getEndpoint('alibaba', createRegionId('nowhere'), 'eci');
    expect(ep).toBe('');
  });

  it('returns empty for AWS-only region queried with alibaba provider', () => {
    const reg = new RegionRegistry();
    // 'sa-east-1' is AWS-only; alibaba provider has no default for it
    const ep = reg.getEndpoint('alibaba', createRegionId('sa-east-1'), 'eci');
    expect(ep).toBe('');
  });

  it('respects runtime overrides', () => {
    const reg = new RegionRegistry();
    reg.setOverride('cn-hangzhou', {
      endpoints: { container: 'eci.custom.example.com' },
    });
    const ep = reg.getEndpoint('alibaba', createRegionId('cn-hangzhou'), 'container');
    expect(ep).toBe('eci.custom.example.com');
  });

  it('returns local config for local region', () => {
    const reg = new RegionRegistry();
    const cfg = reg.getConfig(LOCAL_REGION);
    expect(cfg.endpoints?.container).toBe('http://127.0.0.1:8080');
  });

  it('getConfig with provider hint finds Alibaba defaults', () => {
    const reg = new RegionRegistry();
    // Without being in ALIBABA_REGIONS, 'custom' region has no defaults
    const cfg = reg.getConfig(createRegionId('cn-hangzhou'), 'alibaba');
    expect(cfg.endpoints?.container).toBe('eci.cn-hangzhou.aliyuncs.com');
  });

  it('listRegions returns all known regions plus overrides', () => {
    const reg = new RegionRegistry();
    reg.setOverride('custom-1', {});
    const list = reg.listRegions();
    expect(list).toContain('cn-hangzhou');
    expect(list).toContain('local');
    expect(list).toContain('custom-1');
  });

  it('getConfig returns empty object for unknown region', () => {
    const reg = new RegionRegistry();
    const cfg = reg.getConfig(createRegionId('unknown-region'));
    expect(cfg).toEqual({});
  });

  it('getEndpoint with fallback for Alibaba without explicit endpoint', () => {
    const reg = new RegionRegistry();
    const ep = reg.getEndpoint('alibaba', createRegionId('cn-shanghai'), 'metrics');
    expect(ep).toBe('eci.cn-shanghai.aliyuncs.com');
  });

  it('removeOverride reverts to default', () => {
    const reg = new RegionRegistry();
    reg.setOverride('cn-hangzhou', { endpoints: { container: 'custom' } });
    reg.removeOverride('cn-hangzhou');
    const ep = reg.getEndpoint('alibaba', createRegionId('cn-hangzhou'), 'container');
    expect(ep).toBe('eci.cn-hangzhou.aliyuncs.com');
  });

  it('seed constructor pre-populates overrides', () => {
    const reg = new RegionRegistry([
      { region: 'cn-beijing', config: { vswitchId: 'vsw-xxx' } },
    ]);
    const cfg = reg.getConfig(createRegionId('cn-beijing'));
    expect(cfg.vswitchId).toBe('vsw-xxx');
  });
});

describe('RegionRegistry singleton', () => {
  beforeAll(() => {
    // Reset so test is hermetic
    (setDefaultRegistry as any)(undefined);
  });

  it('getDefaultRegistry creates on first call', () => {
    const r1 = getDefaultRegistry();
    const r2 = getDefaultRegistry();
    expect(r1).toBe(r2);
  });

  it('setDefaultRegistry replaces the instance', () => {
    const custom = new RegionRegistry();
    setDefaultRegistry(custom);
    expect(getDefaultRegistry()).toBe(custom);

    // Reset for other tests
    (setDefaultRegistry as any)(undefined);
  });
});
