import type { Hono } from 'hono';
import type { FeatureDeps } from '../../core/deps.ts';
import { ConsoleLogger } from '../../core/audit/console-logger.ts';
import { PermissionService } from './service.ts';
import { createPermissionRouter } from './handler.ts';

export function createRouter(deps: FeatureDeps): Hono<{ Variables: AppContext }> {
  const service = new PermissionService(deps.stores.atomic, new ConsoleLogger(), deps.audit);
  return createPermissionRouter(service);
}
