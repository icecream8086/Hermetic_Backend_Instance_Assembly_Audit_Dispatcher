import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeTimerBackend } from '../../../src/core/scheduler/fake-timer-backend.ts';
import { SetIntervalBackend } from '../../../src/core/scheduler/set-interval-backend.ts';
import { ManualBackend } from '../../../src/core/scheduler/manual-backend.ts';

describe('FakeTimerBackend', () => {
  it('fires callback on tick', () => {
    const timer = new FakeTimerBackend();
    let fired = false;
    const handle = timer.start(() => { fired = true; }, 1000);
    timer.tick();
    expect(fired).toBe(true);
    handle.clear();
  });

  it('does not fire before tick', () => {
    const timer = new FakeTimerBackend();
    let fired = false;
    const handle = timer.start(() => { fired = true; }, 1000);
    expect(fired).toBe(false);
    handle.clear();
  });

  it('fires callback multiple times', () => {
    const timer = new FakeTimerBackend();
    let count = 0;
    const handle = timer.start(() => { count++; }, 1000);
    timer.tick();
    timer.tick();
    timer.tick();
    expect(count).toBe(3);
    handle.clear();
  });

  it('handle.clear() stops firing', () => {
    const timer = new FakeTimerBackend();
    let count = 0;
    const handle = timer.start(() => { count++; }, 1000);
    timer.tick();
    handle.clear();
    timer.tick();
    expect(count).toBe(1);
  });

  it('start returns handle and tick fires handler', () => {
    const timer = new FakeTimerBackend();
    let fired = false;
    const handle = timer.start(() => { fired = true; }, 1000);
    expect(typeof handle.clear).toBe('function');
    timer.tick();
    expect(fired).toBe(true);
  });
});

describe('SetIntervalBackend', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires at given interval', () => {
    let fired = false;
    const timer = new SetIntervalBackend();
    const handle = timer.start(() => { fired = true; }, 1000);
    vi.advanceTimersByTime(1000);
    expect(fired).toBe(true);
    handle.clear();
  });

  it('does not fire early', () => {
    let fired = false;
    const timer = new SetIntervalBackend();
    const handle = timer.start(() => { fired = true; }, 1000);
    vi.advanceTimersByTime(500);
    expect(fired).toBe(false);
    handle.clear();
  });

  it('handle.clear() stops interval', () => {
    let count = 0;
    const timer = new SetIntervalBackend();
    const handle = timer.start(() => { count++; }, 1000);
    vi.advanceTimersByTime(1000);
    handle.clear();
    vi.advanceTimersByTime(2000);
    expect(count).toBe(1);
  });
});

describe('ManualBackend', () => {
  it('does not auto-fire', () => {
    let fired = false;
    const timer = new ManualBackend();
    const handle = timer.start(() => { fired = true; }, 1000);
    expect(fired).toBe(false);
    handle.clear();
  });
});
