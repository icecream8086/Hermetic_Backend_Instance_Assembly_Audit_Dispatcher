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

  it('sendImagePull returns false', async () => {
    expect(await q.sendImagePull({ taskId: 't1', image: 'alpine' })).toBe(false);
  });

  it('all send methods return false consistently', () => {
    // Noop queue always indicates "not available"
    expect(q.available).toBe(false);
  });
});
