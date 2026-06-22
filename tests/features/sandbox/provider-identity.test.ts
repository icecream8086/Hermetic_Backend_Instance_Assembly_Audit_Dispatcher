import { join } from 'node:path'; import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach } from 'vitest';
import { FileKVAtomicStore } from '../../../src/core/store/adapters/file-kv.ts';
import { SandboxService } from '../../../src/features/sandbox/sandbox.service.ts';
import { ConsoleLogger } from '../../../src/core/logger/console-logger.ts';
import { StubContainerProvider } from '../../../src/providers/stub/container.ts';
import { InstanceService } from '../../../src/core/region/instance.ts';
import type { ComputeInstance } from '../../../src/core/region/instance.ts';
import { SandboxStatus, SpotStrategy, createSandboxId } from '../../../src/features/sandbox/types.ts';
import type { CreateSandboxInput, Sandbox } from '../../../src/features/sandbox/types.ts';
import { ProviderResolutionError } from '../../../src/core/provider/errors.ts';
import type { IProviderRegistry, IContainerProvider } from '../../../src/core/provider/interfaces.ts';
import type { RegionId } from '../../../src/core/region/types.ts';

function atomic() { return new FileKVAtomicStore(join(tmpdir(), 'hbi-provident-' + crypto.randomUUID().slice(0, 8))); }

function baseInput(overrides?: Partial<CreateSandboxInput>): CreateSandboxInput {
  return {
    name: 'identity-test',
    region: 'local' as unknown as RegionId,
    resourceSpec: { cpu: 1, memory: 512 },
    spotStrategy: SpotStrategy.None,
    restartPolicy: 'Never',
    containers: [{ name: 'app', image: 'nginx:latest' }],
    network: { allocatePublicIp: false },
    ...overrides,
  };
}

/** A mock providerRegistry that returns a stub provider for resolveContainer. */
function mockRegistry(containerProvider?: IContainerProvider): IProviderRegistry {
  const stub = containerProvider ?? new StubContainerProvider();
  return {
    container: stub,
    resolveContainer: async () => stub,
    resolveImage: async () => ({ pull: async () => ({ id: 'img', tags: [] }) } as any),
    resolveGroup: async () => undefined,
    resolveRawEciApi: async () => undefined,
    resolveCrApi: async () => undefined,
    resolveOssOpenApi: async () => undefined,
    dns: {} as any,
    metrics: {} as any,
    image: {} as any,
    capabilities: {} as any,
    provider: () => undefined,
    availableProviders: () => [],
    s3Account: () => undefined,
    listS3Accounts: () => [],
    rawEciApi: () => undefined,
    crApi: () => undefined,
    ossOpenApi: () => undefined,
  };
}

describe('SandboxService provider identity persistence', () => {
  let store: ReturnType<typeof atomic>;
  let instanceService: InstanceService;

  beforeEach(() => {
    store = atomic();
    instanceService = new InstanceService(store);
  });

  describe('provision without instanceId', () => {
    it('does NOT persist providerIdentity when no instance is resolved', async () => {
      const svc = new SandboxService(store, new ConsoleLogger(), new StubContainerProvider());
      const sandbox = await svc.provision(baseInput());
      expect((sandbox.config as any).providerIdentity).toBeUndefined();
    });

    it('creates sandbox successfully with stub provider', async () => {
      const svc = new SandboxService(store, new ConsoleLogger(), new StubContainerProvider());
      const sandbox = await svc.provision(baseInput());
      expect(sandbox.status).toBe(SandboxStatus.Running);
      expect(sandbox.providerId).toMatch(/^stub-eci-/);
    });
  });

  describe('provision with instanceId', () => {
    it('persists providerIdentity.platform and instanceId', async () => {
      // Persist an Alibaba instance in the store
      const inst: ComputeInstance = {
        id: 'inst_ali_hz' as any,
        name: 'ali-hz',
        platform: 'alibaba',
        region: 'cn-hangzhou' as any,
        zone: 'cn-hangzhou-g' as any,
        endpoint: 'eci.cn-hangzhou.aliyuncs.com',
        capabilities: { container: true },
        status: 'online',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await store.set('instance:inst_ali_hz', inst, null);

      const svc = new SandboxService(
        store, new ConsoleLogger(), new StubContainerProvider(),
        mockRegistry(), // providerRegistry so #resolveProvider succeeds
        undefined, undefined, undefined, instanceService,
      );
      const sandbox = await svc.provision(baseInput({ instanceId: 'inst_ali_hz' as any }));
      const identity = (sandbox.config as any).providerIdentity;
      expect(identity).toBeDefined();
      expect(identity.platform).toBe('alibaba');
      expect(identity.instanceId).toBe('inst_ali_hz');
    });

    it('providerIdentity.region and zoneId match instance', async () => {
      const inst: ComputeInstance = {
        id: 'inst_ali_sh' as any,
        name: 'ali-sh',
        platform: 'alibaba',
        region: 'cn-shanghai' as any,
        zone: 'cn-shanghai-b' as any,
        endpoint: 'eci.cn-shanghai.aliyuncs.com',
        capabilities: { container: true },
        status: 'online',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await store.set('instance:inst_ali_sh', inst, null);

      const svc = new SandboxService(
        store, new ConsoleLogger(), new StubContainerProvider(),
        mockRegistry(), undefined, undefined, undefined, instanceService,
      );
      const sandbox = await svc.provision(baseInput({ instanceId: 'inst_ali_sh' as any }));
      const identity = (sandbox.config as any).providerIdentity;
      expect(identity.region).toBe('cn-shanghai');
      expect(identity.zoneId).toBe('cn-shanghai-b');
    });

    it('persists both config.instanceId and providerIdentity for backward compat', async () => {
      const inst: ComputeInstance = {
        id: 'inst_dual' as any,
        name: 'dual-info',
        platform: 'alibaba',
        region: 'cn-beijing' as any,
        zone: 'cn-beijing-a' as any,
        endpoint: 'eci.cn-beijing.aliyuncs.com',
        capabilities: { container: true },
        status: 'online',
        credentialRef: 'cred_ref_1',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await store.set('instance:inst_dual', inst, null);

      const svc = new SandboxService(
        store, new ConsoleLogger(), new StubContainerProvider(),
        mockRegistry(), undefined, undefined, undefined, instanceService,
      );
      const sandbox = await svc.provision(baseInput({ instanceId: 'inst_dual' as any }));
      expect(sandbox.config.instanceId).toBe('inst_dual');
      const identity = (sandbox.config as any).providerIdentity;
      expect(identity.credentialRef).toBe('cred_ref_1');
    });
  });

  describe('#resolveProvider throws instead of silent fallback', () => {
    it('throws ProviderResolutionError when instanceId is set but no providerRegistry', async () => {
      const svc = new SandboxService(
        store, new ConsoleLogger(), new StubContainerProvider(),
        undefined, // no providerRegistry
        undefined, undefined, undefined, instanceService,
      );
      await expect(svc.provision(baseInput({ instanceId: 'inst_missing' as any })))
        .rejects.toThrow(ProviderResolutionError);
    });

    it('throws ProviderResolutionError when instanceId is set but resolveContainer returns null', async () => {
      const nullRegistry: IProviderRegistry = {
        ...mockRegistry(),
        resolveContainer: async () => null as unknown as IContainerProvider,
      };
      const svc = new SandboxService(
        store, new ConsoleLogger(), new StubContainerProvider(),
        nullRegistry, undefined, undefined, undefined, instanceService,
      );
      await expect(svc.provision(baseInput({ instanceId: 'inst_null' as any })))
        .rejects.toThrow(ProviderResolutionError);
    });

    it('does NOT throw when no instanceId is set (uses default containerProvider)', async () => {
      const svc = new SandboxService(store, new ConsoleLogger(), new StubContainerProvider());
      const sandbox = await svc.provision(baseInput()); // no instanceId
      expect(sandbox.status).toBe(SandboxStatus.Running);
    });
  });
});

describe('SandboxService error handling consistency', () => {
  let store: ReturnType<typeof atomic>;

  beforeEach(() => { store = atomic(); });

  it('syncRuntime works for stub provider sandboxes', async () => {
    const svc = new SandboxService(store, new ConsoleLogger(), new StubContainerProvider());
    const sandbox = await svc.provision(baseInput());
    const runtime = await svc.syncRuntime(sandbox.id);
    expect(runtime).toBeDefined();
    expect(runtime.name).toBeDefined();
  });

  it('getById returns null for non-existent sandbox (does not throw)', async () => {
    const svc = new SandboxService(store, new ConsoleLogger(), new StubContainerProvider());
    const result = await svc.getById(createSandboxId('nonexistent'));
    expect(result).toBeNull();
  });

  it('terminate completes local cleanup even when provider delete fails', async () => {
    const failingProvider = new StubContainerProvider();
    failingProvider.delete = async () => { throw new Error('ECI unavailable'); };

    const svc = new SandboxService(store, new ConsoleLogger(), failingProvider);
    const sandbox = await svc.provision(baseInput());
    await svc.terminate(sandbox.id, 'actor1');

    const entry = await store.get<Sandbox>('sandbox:' + sandbox.id);
    expect(entry!.value.status).toBe(SandboxStatus.Deleted);
  });
});
