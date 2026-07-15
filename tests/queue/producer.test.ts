import { describe, it, expect, beforeEach } from 'vitest';
import { QueueProducer } from '../../src/queue/producer.ts';
import type { TaskMessage } from '../../src/queue/types.ts';

describe('QueueProducer (white-box)', () => {
  describe('available flag', () => {
    it('returns false when no Queue binding', () => {
      const p = new QueueProducer(undefined);
      expect(p.available).toBe(false);
    });

    it('returns true when Queue binding present', () => {
      const p = new QueueProducer({ send: async () => {}, sendBatch: async () => {} } as any);
      expect(p.available).toBe(true);
    });
  });

  describe('with no Queue (fallback mode)', () => {
    let p: QueueProducer;
    beforeEach(() => { p = new QueueProducer(undefined); });

    it('sendImagePull returns false', async () => {
      expect(await p.sendImagePull({ taskId: 't1', image: 'nginx' })).toBe(false);
    });
  });

  describe('with Queue binding present', () => {
    it('sendImagePull sends message to queue', async () => {
      let sent: TaskMessage | null = null;
      const p = new QueueProducer({ send: async (m: TaskMessage) => { sent = m; } } as any);
      const result = await p.sendImagePull({ taskId: 't1', image: 'alpine' });
      expect(result).toBe(true);
      expect(sent!.type).toBe('image:pull');
    });

    it('send returns false when queue.send throws', async () => {
      const p = new QueueProducer({ send: async () => { throw new Error('fail'); } } as any);
      expect(await p.send({ type: 'image:pull', payload: { taskId: 'x', image: 'x' }, id: 'x', timestamp: 1 })).toBe(false);
    });

    it('generates unique id per message', async () => {
      const messages: TaskMessage[] = [];
      const p = new QueueProducer({ send: async (m: TaskMessage) => { messages.push(m); } } as any);
      await p.send({ type: 'image:pull', payload: { taskId: 'a', image: 'a' }, id: 'a', timestamp: 1 });
      await p.send({ type: 'image:pull', payload: { taskId: 'b', image: 'b' }, id: 'b', timestamp: 1 });
      expect(messages[0]!.id).not.toBe(messages[1]!.id);
    });

    it('sendBatch wraps each message in { body }', async () => {
      let batch: any[] = [];
      const p = new QueueProducer({ sendBatch: async (b: any[]) => { batch = b; } } as any);
      const count = await p.sendBatch([
        { type: 'image:pull', payload: { taskId: 't1', image: 'nginx' }, timestamp: 1, id: 'i1' },
      ]);
      expect(count).toBe(1);
      expect(batch[0].body.type).toBe('image:pull');
    });
  });
});
