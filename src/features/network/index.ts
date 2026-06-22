import { Hono } from 'hono';
import type { FeatureDeps } from '../../core/deps.ts';
import { ConsoleLogger } from '../../core/logger/console-logger.ts';
import { SecurityGroupService } from './service.ts';
import { createSecurityGroupRouter } from './handler.ts';
import { InstanceService } from '../../core/region/instance.ts';

export function createRouter(deps: FeatureDeps): Hono<any> {
  const instanceSvc = new InstanceService(deps.stores.atomic);
  const svc = new SecurityGroupService(deps.stores.atomic, new ConsoleLogger(), deps.audit, deps.providers.networkPolicy, instanceSvc);
  return createSecurityGroupRouter(svc);
}
