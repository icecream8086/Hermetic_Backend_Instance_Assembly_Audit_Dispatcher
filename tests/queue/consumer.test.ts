import { join } from 'node:path'; import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach } from 'vitest';
import { processTaskBatch } from '../../src/queue/consumer.ts';
import type { TaskMessage } from '../../src/queue/types.ts';
import { FileKVAtomicStore } from '../../src/core/store/adapters/file-kv.ts';
import { SandboxStatus } from '../../src/features/sandbox/types.ts';
import type { IContainerProvider } from '../../src/core/provider/interfaces.ts';

function store() { return new FileKVAtomicStore(join(tmpdir(), 'hbi-test-' + crypto.randomUUID().slice(0, 8))); }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeApp(overrides?: any) {
  const atomic = store();
  return {
    stores: { atomic, query: {} as any, blob: {} as any, metrics: {} as any },
    providers: {
      container: { delete: async () => {} },
      resolveImage: async () => ({ pull: async () => ({ id: 'img1', tags: ['latest'] }) }),
      image: { pull: async () => ({ id: 'img1', tags: ['latest'] }) },
    },
    eventBus: {} as any,
    eventLoop: {} as any,
    audit: { write: async () => {} } as any,
    dispose: async () => {},
    seed: async () => {},
    ...overrides,
  };
}

function makeMsg(type: string, payload: unknown): TaskMessage {
  return { type, payload, timestamp: Date.now(), id: crypto.randomUUID() } as TaskMessage;
}

function makeBatch(msgs: TaskMessage[]): MessageBatch<TaskMessage> {
  return {
    messages: msgs.map(body => ({
      body,
      id: body.id,
      timestamp: new Date(body.timestamp),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ack: () => {}, retry: () => {}, retryAll: () => {},
    } as any)),
    queue: 'test',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ackAll: () => {}, retryAll: () => {},
  } as any;
}

describe('processTaskBatch (white-box)', () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => { app = makeApp(); });

  describe('sandbox:gc', () => {
    it('deletes provider resource and updates sandbox state to Deleted', async () => {
      let deleted = false;
      app.providers.container.delete = async () => { deleted = true; };
      await app.stores.atomic.set('sandbox:ids', ['sb_gc'], null);
      await app.stores.atomic.set('sandbox:sb_gc', { status: SandboxStatus.Running, providerId: 'p1', config: { region: 'local' }, name: 'to-delete', containers: [{ name: 'c1' }], createdAt: 1, updatedAt: Date.now() }, null);

      const msg = makeMsg('sandbox:gc', { sandboxId: 'sb_gc', reason: 'manual', providerId: 'p1', region: 'local', containerCount: 1, sandboxName: 'to-delete', createdAt: 1 });
      let acked = false;
      const batchMsg = { body: msg, id: msg.id, timestamp: new Date(), ack: () => { acked = true; }, retry: () => {} };
      await processTaskBatch({ messages: [batchMsg as any], queue: 't', ackAll: () => {}, retryAll: () => {} } as any, async () => app);

      expect(deleted).toBe(true);
      expect(acked).toBe(true);
      const entry = await app.stores.atomic.get<any>('sandbox:sb_gc');
      expect(entry!.value.status).toBe(SandboxStatus.Deleted);
    });

    it('removes sandbox from index on GC', async () => {
      await app.stores.atomic.set('sandbox:ids', ['sb_idx'], null);
      await app.stores.atomic.set('sandbox:sb_idx', { status: SandboxStatus.Running, providerId: 'p1', config: { region: 'local' }, name: 'idx-test', containers: [{ name: 'c1' }], createdAt: 1, updatedAt: Date.now() }, null);

      const msg = makeMsg('sandbox:gc', { sandboxId: 'sb_idx', reason: 'manual', providerId: 'p1', region: 'local', containerCount: 1, sandboxName: 'idx-test', createdAt: 1 });
      await processTaskBatch(makeBatch([msg]), async () => app);

      const idx = await app.stores.atomic.get<string[]>('sandbox:ids');
      expect(idx?.value).not.toContain('sb_idx');
    });

    it('acks without action when sandbox already deleted', async () => {
      let acked = false;
      const msg = makeMsg('sandbox:gc', { sandboxId: 'sb_nope', reason: 'manual', providerId: 'p1', region: 'local', containerCount: 1, sandboxName: 'nope', createdAt: 1 });
      const batchMsg = { body: msg, id: msg.id, timestamp: new Date(), ack: () => { acked = true; }, retry: () => {} };
      await processTaskBatch({ messages: [batchMsg as any], queue: 't', ackAll: () => {}, retryAll: () => {} } as any, async () => app);
      expect(acked).toBe(true);
    });

    it('uses resolveContainer when instanceId is set (no fallback to providers.container)', async () => {
      let defaultDeleteCalled = false;
      let resolvedDeleteCalled = false;

      app.providers.container.delete = async () => { defaultDeleteCalled = true; };
      const resolvedProvider: IContainerProvider = {
        create: async () => ({ providerId: 'p_resolved' }),
        describe: async () => ({ sandboxes: [] }),
        delete: async () => { resolvedDeleteCalled = true; },
        getLogs: async () => ({ containerName: 'c1', content: '' }),
      };
      app.providers.resolveContainer = async (_id: any) => resolvedProvider;

      await app.stores.atomic.set('sandbox:ids', ['sb_eci'], null);
      await app.stores.atomic.set('sandbox:sb_eci', {
        status: SandboxStatus.Running, providerId: 'eci_abc',
        config: { region: 'cn-hangzhou', instanceId: 'inst_ali' },
        name: 'eci-sandbox', containers: [{ name: 'c1' }], createdAt: 1, updatedAt: Date.now(),
      }, null);

      const msg = makeMsg('sandbox:gc', {
        sandboxId: 'sb_eci', reason: 'manual', providerId: 'eci_abc',
        region: 'cn-hangzhou', instanceId: 'inst_ali', containerCount: 1,
        sandboxName: 'eci-sandbox', createdAt: 1,
      });
      let acked = false;
      const batchMsg = { body: msg, id: msg.id, timestamp: new Date(), ack: () => { acked = true; }, retry: () => {} };
      await processTaskBatch({ messages: [batchMsg as any], queue: 't', ackAll: () => {}, retryAll: () => {} } as any, async () => app);

      // Must use resolveContainer result, NOT the default container
      expect(resolvedDeleteCalled).toBe(true);
      expect(defaultDeleteCalled).toBe(false);
      expect(acked).toBe(true);
    });

    it('falls back to providers.container when instanceId is NOT set', async () => {
      let defaultDeleteCalled = false;
      let resolveCalled = false;

      app.providers.container.delete = async () => { defaultDeleteCalled = true; };
      app.providers.resolveContainer = async (_id: any) => { resolveCalled = true; return null as any; };

      await app.stores.atomic.set('sandbox:ids', ['sb_local'], null);
      await app.stores.atomic.set('sandbox:sb_local', {
        status: SandboxStatus.Running, providerId: 'p_local',
        config: { region: 'local' },
        name: 'local-sandbox', containers: [{ name: 'c1' }], createdAt: 1, updatedAt: Date.now(),
      }, null);

      const msg = makeMsg('sandbox:gc', {
        sandboxId: 'sb_local', reason: 'manual', providerId: 'p_local',
        region: 'local', containerCount: 1, sandboxName: 'local-sandbox', createdAt: 1,
        // No instanceId → uses providers.container
      });
      let acked = false;
      const batchMsg = { body: msg, id: msg.id, timestamp: new Date(), ack: () => { acked = true; }, retry: () => {} };
      await processTaskBatch({ messages: [batchMsg as any], queue: 't', ackAll: () => {}, retryAll: () => {} } as any, async () => app);

      expect(defaultDeleteCalled).toBe(true);
      // resolveContainer should not be called when no instanceId
      expect(resolveCalled).toBe(false);
      expect(acked).toBe(true);
    });

    it('still acks GC when provider delete fails (best-effort)', async () => {
      app.providers.container.delete = async () => { throw new Error('ECI API unreachable'); };

      await app.stores.atomic.set('sandbox:ids', ['sb_fail'], null);
      await app.stores.atomic.set('sandbox:sb_fail', {
        status: SandboxStatus.Running, providerId: 'p_fail',
        config: { region: 'cn-hangzhou' },
        name: 'fail-sandbox', containers: [{ name: 'c1' }], createdAt: 1, updatedAt: Date.now(),
      }, null);

      const msg = makeMsg('sandbox:gc', {
        sandboxId: 'sb_fail', reason: 'manual', providerId: 'p_fail',
        region: 'cn-hangzhou', containerCount: 1, sandboxName: 'fail-sandbox', createdAt: 1,
      });
      let acked = false;
      const batchMsg = { body: msg, id: msg.id, timestamp: new Date(), ack: () => { acked = true; }, retry: () => {} };
      await processTaskBatch({ messages: [batchMsg as any], queue: 't', ackAll: () => {}, retryAll: () => {} } as any, async () => app);

      // Should still complete — provider delete is best-effort
      expect(acked).toBe(true);
      const entry = await app.stores.atomic.get<any>('sandbox:sb_fail');
      expect(entry!.value.status).toBe(SandboxStatus.Deleted);
    });
  });

  describe('image:pull', () => {
    it('pulls image and updates pull-task state to completed', async () => {
      await app.stores.atomic.set('pull-task:t1', { repositoryId: 'repo1', image: 'alpine', createdAt: Date.now() }, null);

      const msg = makeMsg('image:pull', { taskId: 't1', image: 'alpine' });
      let acked = false;
      const batchMsg = { body: msg, id: msg.id, timestamp: new Date(), ack: () => { acked = true; }, retry: () => {} };
      await processTaskBatch({ messages: [batchMsg as any], queue: 't', ackAll: () => {}, retryAll: () => {} } as any, async () => app);

      expect(acked).toBe(true);
      const task = await app.stores.atomic.get<any>('pull-task:t1');
      expect(task!.value.status).toBe('completed');
    });

    it('retries when pull-task not found (already cleaned up)', async () => {
      let acked = false;
      const msg = makeMsg('image:pull', { taskId: 't2', image: 'alpine' });
      const batchMsg = { body: msg, id: msg.id, timestamp: new Date(), ack: () => { acked = true; }, retry: () => {} };
      await processTaskBatch({ messages: [batchMsg as any], queue: 't', ackAll: () => {}, retryAll: () => {} } as any, async () => app);
      expect(acked).toBe(true); // acks as "already cleaned up"
    });
  });

  describe('bucket-key:rotate', () => {
    it('rotates an expired bucket key with new secret', async () => {
      const now = Date.now();
      await app.stores.atomic.set('bucket-key:bk_r', { accessKeyId: 'ak1', secretValue: 'ak1:old', version: 1, rotationIntervalMs: 86400000, expiresAt: now - 1 }, null);

      let acked = false;
      const msg = makeMsg('bucket-key:rotate', { bindingId: 'bk_r' });
      const batchMsg = { body: msg, id: msg.id, timestamp: new Date(), ack: () => { acked = true; }, retry: () => {} };
      await processTaskBatch({ messages: [batchMsg as any], queue: 't', ackAll: () => {}, retryAll: () => {} } as any, async () => app);

      expect(acked).toBe(true);
      const entry = await app.stores.atomic.get<any>('bucket-key:bk_r');
      expect(entry!.value.expiresAt).toBeGreaterThan(now);
      expect(entry!.value.secretValue).not.toBe('ak1:old');
    });

    it('skips rotation when binding already cleaned up', async () => {
      let acked = false;
      const msg = makeMsg('bucket-key:rotate', { bindingId: 'bk_missing' });
      const batchMsg = { body: msg, id: msg.id, timestamp: new Date(), ack: () => { acked = true; }, retry: () => {} };
      await processTaskBatch({ messages: [batchMsg as any], queue: 't', ackAll: () => {}, retryAll: () => {} } as any, async () => app);
      expect(acked).toBe(true);
    });
  });

  describe('unknown task type', () => {
    it('retries with error for unknown type', async () => {
      let retried = false;
      const msg = { type: 'unknown:task', payload: {}, id: 'id1', timestamp: Date.now() } as TaskMessage;
      const batchMsg = { body: msg, id: msg.id, timestamp: new Date(), ack: () => {}, retry: () => { retried = true; } };
      await processTaskBatch({ messages: [batchMsg as any], queue: 't', ackAll: () => {}, retryAll: () => {} } as any, async () => app);
      expect(retried).toBe(true);
    });
  });
});
