import { describe, it, expect, vi } from 'vitest';
import { ConsoleLogger } from '../../../src/core/audit/console-logger.ts';
import { KernLevel } from '../../../src/core/audit/kern-level.ts';

describe('ConsoleLogger', () => {
  describe('writeSync', () => {
    it('logs a message and returns an id', async () => {
      const logger = new ConsoleLogger();
      const id = await logger.writeSync({ facility: 'test', level: KernLevel.INFO, message: 'hello' });
      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
    });
  });

  describe('panic hook', () => {
    it('triggers panic handler on CRIT level', async () => {
      const { setPanicHandler } = await import('../../../src/core/audit/console-logger.ts');
      const panicFn = vi.fn();
      setPanicHandler(panicFn);

      const logger = new ConsoleLogger();
      await logger.writeSync({ facility: 'test', level: KernLevel.CRIT, message: 'system failure' });
      expect(panicFn).toHaveBeenCalledOnce();
      expect(panicFn).toHaveBeenCalledWith('system failure');

      setPanicHandler(null);
    });

    it('does not trigger panic on INFO level', async () => {
      const { setPanicHandler } = await import('../../../src/core/audit/console-logger.ts');
      const panicFn = vi.fn();
      setPanicHandler(panicFn);

      const logger = new ConsoleLogger();
      await logger.writeSync({ facility: 'test', level: KernLevel.INFO, message: 'normal operation' });
      expect(panicFn).not.toHaveBeenCalled();

      setPanicHandler(null);
    });
  });
});
