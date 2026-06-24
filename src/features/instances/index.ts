import { Hono } from 'hono';
import type { FeatureDeps } from '../../core/deps.ts';
import { ConsoleLogger } from '../../core/audit/console-logger.ts';
import { RunnerService } from './service.ts';
import { createInstancesRouter } from './handler.ts';

export function createRouter(deps: FeatureDeps): Hono<any> {
  const service = new RunnerService(deps.stores.atomic, new ConsoleLogger(), deps.audit);
  return createInstancesRouter(service);
}
