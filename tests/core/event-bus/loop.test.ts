import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../../src/core/event-bus/bus.ts';
import { EventLoop } from '../../../src/core/event-bus/loop.ts';
import { FakeTimerBackend } from '../../../src/core/scheduler/fake-timer-backend.ts';
import { createEvent } from '../../../src/core/event-bus/types.ts';
import type { TriggerEventInput } from '../../../src/core/event-bus/types.ts';

describe('EventLoop', () => {
  // ─── Construction ───

  describe('construction', () => {
    it('creates idle loop with defaults', () => {
      const bus = new EventBus();
      const loop = new EventLoop(bus, undefined, new FakeTimerBackend());
      const s = loop.status();
      expect(s.running).toBe(false);
      expect(s.paused).toBe(false);
      expect(s.queueSize).toBe(0);
      expect(s.config.intervalMs).toBe(60000);
      expect(s.config.batchSize).toBe(0);
    });

    it('auto-starts when configured', () => {
      const bus = new EventBus();
      const backend = new FakeTimerBackend();
      const loop = new EventLoop(bus, { autoStart: true }, backend);
      expect(loop.status().running).toBe(true);
      expect(backend.isRunning).toBe(true);
      loop.stop();
    });
  });

  // ─── Lifecycle ───

  describe('start / stop', () => {
    it('start is idempotent', () => {
      const bus = new EventBus();
      const backend = new FakeTimerBackend();
      const loop = new EventLoop(bus, { intervalMs: 60000 }, backend);
      loop.start();
      loop.start(); // second call is no-op
      expect(loop.status().running).toBe(true);
      expect(backend.isRunning).toBe(true);
      loop.stop();
    });

    it('stop is idempotent', () => {
      const bus = new EventBus();
      const loop = new EventLoop(bus, undefined, new FakeTimerBackend());
      loop.stop(); // never started
      expect(loop.status().running).toBe(false);
    });

    it('dispatches queued events on tick', () => {
      const bus = new EventBus();
      const handler = vi.fn();
      bus.on('test', handler);

      const backend = new FakeTimerBackend();
      const loop = new EventLoop(bus, { intervalMs: 60000 }, backend);
      loop.enqueue(createEvent('test', { n: 1 }));
      loop.enqueue(createEvent('test', { n: 2 }));
      expect(loop.size).toBe(2);

      loop.start();
      expect(backend.intervalMs).toBe(60000);

      // first tick via explicit backend tick()
      backend.tick();
      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'test', payload: { n: 1 } }),
      );
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'test', payload: { n: 2 } }),
      );
      expect(loop.size).toBe(0);
      expect(loop.status().processedCount).toBe(2);

      loop.stop();
    });

    it('enqueueTrigger creates event from external input', () => {
      const bus = new EventBus();
      const loop = new EventLoop(bus, undefined, new FakeTimerBackend());
      const input: TriggerEventInput = { type: 'sandbox.create', payload: { cpu: 2 } };

      const event = loop.enqueueTrigger(input);

      expect(event.type).toBe('sandbox.create');
      expect(event.payload).toEqual({ cpu: 2 });
      expect(event.id).toBeTruthy();
      expect(event.timestamp).toBeGreaterThan(0);
      expect(loop.size).toBe(1);
    });
  });

  // ─── Pause / Resume ───

  describe('pause / resume', () => {
    it('does not dispatch while paused', () => {
      const bus = new EventBus();
      const handler = vi.fn();
      bus.on('test', handler);

      const backend = new FakeTimerBackend();
      const loop = new EventLoop(bus, { intervalMs: 60000, autoStart: true }, backend);
      loop.enqueue(createEvent('test'));

      loop.pause();
      backend.tick();
      expect(handler).not.toHaveBeenCalled();

      loop.resume();
      backend.tick();
      expect(handler).toHaveBeenCalledOnce();
      loop.stop();
    });
  });

  // ─── batchSize ───

  describe('batchSize', () => {
    it('batchSize=0 drains all queued events per tick', () => {
      const bus = new EventBus();
      const handler = vi.fn();
      bus.on('e', handler);

      const backend = new FakeTimerBackend();
      const loop = new EventLoop(bus, { intervalMs: 60000, batchSize: 0 }, backend);
      loop.enqueue(createEvent('e'));
      loop.enqueue(createEvent('e'));
      loop.enqueue(createEvent('e'));

      loop.start();
      backend.tick();
      // all 3 dispatched in one tick
      expect(handler).toHaveBeenCalledTimes(3);
      expect(loop.size).toBe(0);
      loop.stop();
    });

    it('batchSize=1 processes one event per tick (RR mode)', () => {
      const bus = new EventBus();
      const order: string[] = [];
      bus.on('a', () => { order.push('a'); });
      bus.on('b', () => { order.push('b'); });

      const backend = new FakeTimerBackend();
      const loop = new EventLoop(bus, { intervalMs: 60000, batchSize: 1 }, backend);
      loop.enqueue(createEvent('a'));
      loop.enqueue(createEvent('b'));
      loop.enqueue(createEvent('a'));

      loop.start();

      // tick 1: event a
      backend.tick();
      expect(order).toEqual(['a']);
      expect(loop.size).toBe(2);

      // tick 2: event b
      backend.tick();
      expect(order).toEqual(['a', 'b']);

      // tick 3: event a
      backend.tick();
      expect(order).toEqual(['a', 'b', 'a']);
      expect(loop.size).toBe(0);

      loop.stop();
    });
  });

  // ─── configure ───

  describe('configure', () => {
    it('updates config at runtime', () => {
      const bus = new EventBus();
      const loop = new EventLoop(bus, undefined, new FakeTimerBackend());
      expect(loop.status().config.intervalMs).toBe(60000);

      const merged = loop.configure({ intervalMs: 30000, batchSize: 5 });
      expect(merged.intervalMs).toBe(30000);
      expect(merged.batchSize).toBe(5);
      expect(loop.status().config.intervalMs).toBe(30000);
    });

    it('restarts timer when interval changes while running', () => {
      const bus = new EventBus();
      const handler = vi.fn();
      bus.on('t', handler);

      const backend = new FakeTimerBackend();
      const loop = new EventLoop(bus, { intervalMs: 60000, autoStart: true }, backend);
      loop.enqueue(createEvent('t'));

      // shorten interval
      loop.configure({ intervalMs: 10000 });
      expect(backend.intervalMs).toBe(10000);
      backend.tick();

      expect(handler).toHaveBeenCalledOnce();
      expect(loop.status().processedCount).toBe(1);
      loop.stop();
    });
  });

  // ─── status ───

  describe('status', () => {
    it('tracks processedCount', () => {
      const bus = new EventBus();
      bus.on('e', vi.fn());

      const backend = new FakeTimerBackend();
      const loop = new EventLoop(bus, { intervalMs: 60000, autoStart: true }, backend);
      expect(loop.status().processedCount).toBe(0);

      loop.enqueue(createEvent('e'));
      loop.enqueue(createEvent('e'));
      backend.tick();
      expect(loop.status().processedCount).toBe(2);

      loop.enqueue(createEvent('e'));
      backend.tick();
      expect(loop.status().processedCount).toBe(3);

      loop.stop();
    });

    it('reports uptime correctly', () => {
      const bus = new EventBus();
      const loop = new EventLoop(bus, { autoStart: true }, new FakeTimerBackend());
      expect(loop.status().uptimeMs).toBeGreaterThanOrEqual(0);
      loop.stop();
    });
  });

  // ─── Empty queue ───

  describe('empty queue', () => {
    it('tick on empty queue does nothing', () => {
      const bus = new EventBus();
      const handler = vi.fn();
      bus.on('e', handler);

      const backend = new FakeTimerBackend();
      const loop = new EventLoop(bus, { intervalMs: 60000, autoStart: true }, backend);
      backend.tick();
      expect(handler).not.toHaveBeenCalled();
      expect(loop.status().processedCount).toBe(0);
      loop.stop();
    });
  });

  // ─── triggerTick concurrency ───

  describe('triggerTick concurrency', () => {
    it('does not process duplicate batch when triggerTick overlaps', async () => {
      const bus = new EventBus();
      const order: string[] = [];
      bus.on('a', async () => { order.push('a'); await new Promise(r => setTimeout(r, 1)); });
      bus.on('b', async () => { order.push('b'); await new Promise(r => setTimeout(r, 1)); });

      const backend = new FakeTimerBackend();
      const loop = new EventLoop(bus, { batchSize: 2 }, backend);
      loop.enqueue(createEvent('a'));
      loop.enqueue(createEvent('b'));
      loop.enqueue(createEvent('a'));

      // triggerTick with guard — concurrent calls skip
      await Promise.all([
        loop.triggerTick(),
        loop.triggerTick(), // this one should be skipped by #ticking guard
        loop.triggerTick(), // this one too
      ]);

      // Only 2 events processed (batchSize=2), not 6
      expect(order.length).toBe(2);
      expect(loop.size).toBe(1); // one 'a' remains
    });
  });

  // ─── Recovery ───

  describe('recovery', () => {
    it('recovers persisted events from store after construction', async () => {
      const { FileKVAtomicStore } = await import('../../../src/core/store/adapters/file-kv.ts');
      const { mkdtempSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');

      const dir = mkdtempSync(join(tmpdir(), 'hbi-loop-test-'));
      const atomic = new FileKVAtomicStore(dir);

      // Manually persist an event
      const event = createEvent('recovered', { x: 1 });
      await atomic.transact(async (txn) => {
        txn.set('events:pending', [event]);
      });

      const bus = new EventBus();
      const handler = vi.fn();
      bus.on('recovered', handler);

      // Construct EventLoop — should recover the persisted event
      const loop = new EventLoop(bus, { autoStart: false }, undefined, atomic);
      // Wait for async recover to complete (microtask)
      await new Promise(r => setTimeout(r, 10));
      expect(loop.size).toBe(1);
      loop.enqueue(createEvent('recovered'));

      await loop.triggerTick();
      expect(handler).toHaveBeenCalledTimes(2); // recovered + enqueued
    });
  });
});
