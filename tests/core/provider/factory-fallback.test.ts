import { describe, it, expect } from 'vitest';
import { createProviderRegistry } from '../../../src/core/provider/factory.ts';

// The factory's resolveContainer/resolveImage/resolveGroup now throw when instanceId
// is provided but no InstanceProviderResolver is available (no atomicStore).

describe('LazyProviderRegistry no silent fallback', () => {
  function registryWithoutStore() {
    return createProviderRegistry(
      { container: 'stub', region: 'cn-hangzhou' as any, accounts: [], defaultAccount: 'default', dns: 'stub', metrics: 'stub' } as any,
      { backend: 'none', region: 'auto', accounts: [], defaultAccount: 'default' },
      undefined, // NO atomicStore → resolver cannot be initialized
    );
  }

  describe('resolveContainer', () => {
    it('throws when instanceId is set but no atomicStore (no resolver)', async () => {
      const reg = registryWithoutStore();
      await expect(reg.resolveContainer('inst_any' as any))
        .rejects.toThrow('InstanceProviderResolver not available');
    });

    it('returns default container when instanceId is not set', async () => {
      const reg = registryWithoutStore();
      const provider = await reg.resolveContainer(undefined);
      expect(provider).toBeDefined();
      expect(typeof provider.create).toBe('function');
    });
  });

  describe('resolveImage', () => {
    it('throws when instanceId is set but no atomicStore (no resolver)', async () => {
      const reg = registryWithoutStore();
      await expect(reg.resolveImage('inst_any' as any))
        .rejects.toThrow('InstanceProviderResolver not available');
    });

    it('returns default image when instanceId is not set', async () => {
      const reg = registryWithoutStore();
      const provider = await reg.resolveImage(undefined);
      expect(provider).toBeDefined();
      expect(typeof provider.pull).toBe('function');
    });
  });

  describe('resolveGroup', () => {
    it('throws when instanceId is set but no atomicStore (no resolver)', async () => {
      const reg = registryWithoutStore();
      await expect(reg.resolveGroup('inst_any' as any))
        .rejects.toThrow('InstanceProviderResolver not available');
    });

    it('returns default groupContainer when instanceId is not set', async () => {
      const reg = registryWithoutStore();
      const provider = await reg.resolveGroup(undefined);
      // stub config has no group support → undefined
      expect(provider).toBeUndefined();
    });
  });
});

describe('LazyProviderRegistry resolveRawEciApi / resolveCrApi / resolveOssOpenApi', () => {
  // These methods already required instanceId and resolver — just verify consistency
  const reg = createProviderRegistry(
    { container: 'stub', region: 'cn-hangzhou' as any, accounts: [], defaultAccount: 'default', dns: 'stub', metrics: 'stub' } as any,
    { backend: 'none', region: 'auto', accounts: [], defaultAccount: 'default' },
    undefined,
  );

  it('resolveRawEciApi returns undefined when no instanceId (returns default)', async () => {
    // Without instanceId, returns default rawEciApi (which is undefined for stub)
    const api = await reg.resolveRawEciApi(undefined);
    expect(api).toBeUndefined();
  });

  it('resolveCrApi returns undefined when no instanceId', async () => {
    const api = await reg.resolveCrApi(undefined);
    expect(api).toBeUndefined();
  });

  it('resolveOssOpenApi returns undefined when no instanceId', async () => {
    const api = await reg.resolveOssOpenApi(undefined);
    expect(api).toBeUndefined();
  });
});
