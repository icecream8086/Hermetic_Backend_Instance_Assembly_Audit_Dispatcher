import { Hono } from 'hono';
import type { FeatureDeps } from '../../core/deps.ts';
import { ConsoleLogger } from '../../core/audit/console-logger.ts';
import { SysGroupService } from './service.ts';
import { createSysGroupRouter } from './handler.ts';

export function createRouter(deps: FeatureDeps): Hono<any> {
  const service = new SysGroupService(deps.stores.atomic, new ConsoleLogger(), deps.audit);
  return createSysGroupRouter(service);
}
