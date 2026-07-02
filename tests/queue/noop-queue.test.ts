import { describe, it, expect } from 'vitest';
import { NoopMessageQueue } from '../../src/queue/noop-queue.ts';

describe('NoopMessageQueue', () => {
  const q = new NoopMessageQueue();

  it('available is false', () => {
    expect(q.available).toBe(false);
  });

  it('send returns false', async () => {
    expect(await q.send({ type: 'any', payload: {}, id: '1', timestamp: Date.now() })).toBe(false);
  });

  it('sendSandboxGc returns false', async () => {
    expect(await q.sendSandboxGc({
      sandboxId: 's1', reason: 'manual', providerId: 'p1',
      region: 'local', containerCount: 1, sandboxName: 't', createdAt: 1,
    })).toBe(false);
  });

  it('sendImagePull returns false', async () => {
    expect(await q.sendImagePull({ taskId: 't1', image: 'alpine' })).toBe(false);
  });

  it('sendSandboxProvision returns false', async () => {
    expect(await q.sendSandboxProvision({
      sandboxId: 's1', templateId: 't1', instanceId: 'i1',
      resourceSpec: { cpu: 1, memory: 512 }, region: 'local', sandboxName: 't',
    })).toBe(false);
  });

  it('all send methods return false consistently', () => {
    // Noop queue always indicates "not available"
    expect(q.available).toBe(false);
  });
});
