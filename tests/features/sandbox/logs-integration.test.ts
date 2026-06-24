import { join } from 'node:path'; import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach } from 'vitest';
import { FileKVAtomicStore } from '../../../src/core/store/adapters/file-kv.ts';
import { SandboxService } from '../../../src/features/sandbox/sandbox.service.ts';
import { ConsoleLogger } from '../../../src/core/logger/console-logger.ts';
import { StubContainerProvider } from '../../../src/providers/stub/container.ts';
import { SandboxStatus, SpotStrategy, createSandboxId } from '../../../src/features/sandbox/types.ts';
import type { CreateSandboxInput, Sandbox } from '../../../src/features/sandbox/types.ts';
import type { RegionId } from '../../../src/core/region/types.ts';

function atomic() { return new FileKVAtomicStore(join(tmpdir(), 'hbi-logtest-' + crypto.randomUUID().slice(0, 8))); }

function baseInput(overrides?: Partial<CreateSandboxInput>): CreateSandboxInput {
  return {
    name: 'log-test',
    region: 'local' as unknown as RegionId,
    resourceSpec: { cpu: 1, memory: 512 },
    spotStrategy: SpotStrategy.None,
    restartPolicy: 'Never',
    containers: [{ name: 'app', image: 'nginx:latest' }],
    network: { allocatePublicIp: false },
    ...overrides,
  };
}

describe('SandboxService lifecycle', () => {
  let svc: SandboxService;
  let store: ReturnType<typeof atomic>;
  let sandbox: Sandbox;

  beforeEach(async () => {
    store = atomic();
    svc = new SandboxService(store, new ConsoleLogger(), new StubContainerProvider());
    sandbox = await svc.provision(baseInput());
  });

  it('stop transitions Running → Stopped', async () => {
    const stopped = await svc.stop(sandbox.id);
    expect(stopped.status).toBe(SandboxStatus.Stopped);
  });

  it('start transitions Stopped → Running', async () => {
    await svc.stop(sandbox.id);
    const started = await svc.start(sandbox.id);
    expect(started.status).toBe(SandboxStatus.Running);
  });

  it('terminate deletes sandbox and removes from index', async () => {
    await svc.terminate(sandbox.id, 'actor1');
    const entry = await store.get<Sandbox>('sandbox:' + sandbox.id);
    expect(entry!.value.status).toBe(SandboxStatus.Deleted);
    const idx = await store.get<string[]>('sandbox:ids');
    expect(idx?.value).not.toContain(sandbox.id as string);
  });

  it('getById returns null for non-existent sandbox', async () => {
    const result = await svc.getById(createSandboxId('nonexistent'));
    expect(result).toBeNull();
  });

  it('getById returns sandbox after provision', async () => {
    const found = await svc.getById(sandbox.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('log-test');
    expect(found!.status).toBe(SandboxStatus.Running);
  });

  it('list returns provisioned sandboxes', async () => {
    const result = await svc.list();
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(result.items.some(s => s.id === sandbox.id)).toBe(true);
  });

  it('list filters by status', async () => {
    await svc.stop(sandbox.id);
    const running = await svc.list(SandboxStatus.Running);
    expect(running.items.every(s => s.status === SandboxStatus.Running)).toBe(true);
    expect(running.items.some(s => s.id === sandbox.id)).toBe(false); // stopped
    const stopped = await svc.list(SandboxStatus.Stopped);
    expect(stopped.items.some(s => s.id === sandbox.id)).toBe(true);
  });

  it('syncRuntime updates sandbox runtime from provider', async () => {
    const runtime = await svc.syncRuntime(sandbox.id);
    expect(runtime).toBeDefined();
    expect(runtime.name).toBeDefined();
  });

  it('terminate throws error for non-existent sandbox', async () => {
    try {
      await svc.terminate(createSandboxId('nonexistent'));
      expect.fail('should have thrown');
    } catch (e: unknown) {
      expect(e).toBeDefined();
      expect((e as any).statusCode ?? (e as any).status).toBe(404);
    }
  });
});
