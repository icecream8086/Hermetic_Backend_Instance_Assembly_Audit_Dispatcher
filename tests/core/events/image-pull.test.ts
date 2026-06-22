import { join } from 'node:path'; import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach } from 'vitest';
import { registerImagePullHandler, type ImagePullDeps } from '../../../src/core/events/image-pull.ts';
import { EventBus } from '../../../src/core/event-bus/bus.ts';
import { FileKVAtomicStore } from '../../../src/core/store/adapters/file-kv.ts';
import { QueueProducer } from '../../../src/queue/producer.ts';

function store() { return new FileKVAtomicStore(join(tmpdir(), 'hbi-test-' + crypto.randomUUID().slice(0, 8))); }

function makeDeps(overrides?: Partial<ImagePullDeps>): ImagePullDeps {
  const bus = new EventBus();
  return {
    atomic: store(),
    providers: {
      container: {} as any, image: { pull: async () => ({ id: 'img', tags: ['latest'] }) },
      resolveImage: async () => ({ pull: async () => ({ id: 'img', tags: ['latest'] }) }),
    } as any,
    eventBus: bus,
    queueProducer: new QueueProducer(undefined),
    ...overrides,
  };
}

describe('image pull handler (white-box)', () => {
  it('processes image.pull event and marks task completed', async () => {
    const deps = makeDeps();
    const now = Date.now();
    await deps.atomic.set('pull-task:t1', { repositoryId: 'r1', image: 'alpine', createdAt: now }, null);
    registerImagePullHandler(deps);

    // Dispatch the event
    await deps.eventBus.dispatch({ type: 'image.pull', payload: { taskId: 't1', image: 'alpine' }, id: 'e1', timestamp: now, metadata: {} });

    // Small wait for async handler
    await new Promise(r => setTimeout(r, 20));
    const task = await deps.atomic.get<any>('pull-task:t1');
    expect(task!.value.status).toBe('completed');
    expect(task!.value.result.id).toBe('img');
  });

  it('marks task failed on pull error', async () => {
    const deps = makeDeps({
      providers: {
        container: {} as any,
        image: { pull: async () => { throw new Error('registry unreachable'); } },
        resolveImage: async () => ({ pull: async () => { throw new Error('registry unreachable'); } }),
      } as any,
    });
    await deps.atomic.set('pull-task:t2', { repositoryId: 'r2', image: 'bad-image', createdAt: Date.now() }, null);
    registerImagePullHandler(deps);

    await deps.eventBus.dispatch({ type: 'image.pull', payload: { taskId: 't2', image: 'bad-image' }, id: 'e2', timestamp: Date.now(), metadata: {} });
    await new Promise(r => setTimeout(r, 20));
    const task = await deps.atomic.get<any>('pull-task:t2');
    expect(task!.value.status).toBe('failed');
    expect(task!.value.error).toContain('registry unreachable');
  });

  it('queues task when QueueProducer is available', async () => {
    let queued = false;
    const deps = makeDeps({
      queueProducer: { available: true, sendImagePull: async () => { queued = true; return true; } } as any,
    });
    await deps.atomic.set('pull-task:t3', { repositoryId: 'r3', image: 'alpine', createdAt: Date.now() }, null);
    registerImagePullHandler(deps);

    await deps.eventBus.dispatch({ type: 'image.pull', payload: { taskId: 't3', image: 'alpine' }, id: 'e3', timestamp: Date.now(), metadata: {} });
    await new Promise(r => setTimeout(r, 20));
    expect(queued).toBe(true);
    const task = await deps.atomic.get<any>('pull-task:t3');
    expect(task!.value.status).toBe('queued');
  });

  it('skips when task does not exist in store', async () => {
    const deps = makeDeps();
    registerImagePullHandler(deps);
    // Should not throw
    await deps.eventBus.dispatch({ type: 'image.pull', payload: { taskId: 't_missing', image: 'alpine' }, id: 'e4', timestamp: Date.now(), metadata: {} });
    expect(true).toBe(true);
  });
});
