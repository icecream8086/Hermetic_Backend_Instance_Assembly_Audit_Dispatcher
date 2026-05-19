import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../../src/core/event-bus/bus.ts';
import { createEvent } from '../../../src/core/event-bus/types.ts';

describe('EventBus', () => {
  describe('on / dispatch', () => {
    it('invokes handler for matching event type', async () => {
      const bus = new EventBus();
      const handler = vi.fn();
      bus.on('foo', handler);

      const event = createEvent('foo', { x: 1 });
      await bus.dispatch(event);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(event);
    });

    it('does not invoke handler for non-matching type', async () => {
      const bus = new EventBus();
      const handler = vi.fn();
      bus.on('foo', handler);

      await bus.dispatch(createEvent('bar'));

      expect(handler).not.toHaveBeenCalled();
    });

    it('invokes multiple handlers in registration order', async () => {
      const bus = new EventBus();
      const order: number[] = [];
      bus.on('foo', () => { order.push(1); });
      bus.on('foo', () => { order.push(2); });
      bus.on('foo', () => { order.push(3); });

      await bus.dispatch(createEvent('foo'));
      expect(order).toEqual([1, 2, 3]);
    });

    it('awaits async handlers', async () => {
      const bus = new EventBus();
      let flag = false;
      bus.on('foo', async () => {
        await new Promise(r => setTimeout(r, 5));
        flag = true;
      });

      await bus.dispatch(createEvent('foo'));
      expect(flag).toBe(true);
    });
  });

  describe('off', () => {
    it('removes a handler', async () => {
      const bus = new EventBus();
      const handler = vi.fn();
      bus.on('foo', handler);
      bus.off('foo', handler);

      await bus.dispatch(createEvent('foo'));
      expect(handler).not.toHaveBeenCalled();
    });

    it('returns false for unregistered handler', () => {
      const bus = new EventBus();
      expect(bus.off('foo', vi.fn())).toBe(false);
    });
  });

  describe('removeAll', () => {
    it('removes all handlers for a type', async () => {
      const bus = new EventBus();
      const a = vi.fn();
      const b = vi.fn();
      bus.on('foo', a);
      bus.on('foo', b);
      bus.removeAll('foo');

      await bus.dispatch(createEvent('foo'));
      expect(a).not.toHaveBeenCalled();
      expect(b).not.toHaveBeenCalled();
    });

    it('removes all handlers across all types when type omitted', async () => {
      const bus = new EventBus();
      const a = vi.fn();
      const b = vi.fn();
      bus.on('foo', a);
      bus.on('bar', b);
      bus.removeAll();

      await bus.dispatch(createEvent('foo'));
      await bus.dispatch(createEvent('bar'));
      expect(a).not.toHaveBeenCalled();
      expect(b).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('catches sync handler errors via onError', async () => {
      const errors: unknown[] = [];
      const bus = new EventBus({ onError: (err) => { errors.push(err); } });
      bus.on('foo', () => { throw new Error('boom'); });

      await bus.dispatch(createEvent('foo'));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(Error);
    });

    it('catches async handler rejections via onError', async () => {
      const errors: unknown[] = [];
      const bus = new EventBus({ onError: (err) => { errors.push(err); } });
      bus.on('foo', async () => { throw new Error('async boom'); });

      await bus.dispatch(createEvent('foo'));
      expect(errors).toHaveLength(1);
    });

    it('remaining handlers still run after a handler throws', async () => {
      const bus = new EventBus({ onError: () => {} });
      const good = vi.fn();
      bus.on('foo', () => { throw new Error('bad'); });
      bus.on('foo', good);

      await bus.dispatch(createEvent('foo'));
      expect(good).toHaveBeenCalledOnce();
    });
  });

  describe('queries', () => {
    it('registeredTypes returns count of event types', () => {
      const bus = new EventBus();
      expect(bus.registeredTypes).toBe(0);
      bus.on('a', vi.fn());
      bus.on('b', vi.fn());
      expect(bus.registeredTypes).toBe(2);
    });

    it('hasHandlers checks handler existence', () => {
      const bus = new EventBus();
      const h = vi.fn();
      expect(bus.hasHandlers('foo')).toBe(false);
      bus.on('foo', h);
      expect(bus.hasHandlers('foo')).toBe(true);
      bus.off('foo', h);
      expect(bus.hasHandlers('foo')).toBe(false);
    });
  });
});
