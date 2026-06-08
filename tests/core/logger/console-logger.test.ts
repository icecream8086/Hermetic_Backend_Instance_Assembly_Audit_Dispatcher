import { describe, it, expect, vi } from 'vitest';
import { ConsoleLogger } from '../../../src/core/logger/console-logger.ts';
import { formatDmesgLine } from '../../../src/core/utils/dmesg.ts';

describe('ConsoleLogger', () => {
  describe('logSync', () => {
    it('logs a message and returns an id', async () => {
      const logger = new ConsoleLogger();
      const id = await logger.logSync({ facility: 'test' as any, level: 'info', message: 'hello' });
      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
    });
  });

  describe('panic hook', () => {
    it('triggers panic handler on FATAL level', async () => {
      // Need dynamic import since setPanicHandler is module-level
      const { setPanicHandler } = await import('../../../src/core/logger/console-logger.ts');
      const panicFn = vi.fn();
      setPanicHandler(panicFn);

      const logger = new ConsoleLogger();
      await logger.logSync({ facility: 'test' as any, level: 'fatal', message: 'system failure' });
      expect(panicFn).toHaveBeenCalledOnce();
      expect(panicFn).toHaveBeenCalledWith('system failure');

      setPanicHandler(null); // cleanup
    });

    it('does not trigger panic on INFO level', async () => {
      const { setPanicHandler } = await import('../../../src/core/logger/console-logger.ts');
      const panicFn = vi.fn();
      setPanicHandler(panicFn);

      const logger = new ConsoleLogger();
      await logger.logSync({ facility: 'test' as any, level: 'info', message: 'normal operation' });
      expect(panicFn).not.toHaveBeenCalled();

      setPanicHandler(null);
    });
  });
});
