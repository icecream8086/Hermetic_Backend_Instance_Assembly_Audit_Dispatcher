import { Hono } from 'hono';
import type { FeatureDeps } from '../../core/deps.ts';
import { ConsoleLogger } from '../../core/logger/console-logger.ts';
import { SubnetService } from './service.ts';
import { createSubnetRouter } from './handler.ts';
import { InstanceService } from '../../core/region/instance.ts';

export function createRouter(deps: FeatureDeps): Hono<any> {
  const instanceSvc = new InstanceService(deps.stores.atomic);
  const svc = new SubnetService(deps.stores.atomic, new ConsoleLogger(), deps.audit, instanceSvc);
  return createSubnetRouter(svc);
}
