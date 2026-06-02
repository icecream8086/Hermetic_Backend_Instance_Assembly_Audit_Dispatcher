import { Hono } from 'hono';
import type { FeatureDeps } from '../../core/app.ts';
import { ConsoleLogger } from '../../core/logger/console-logger.ts';
import { NetworkService } from './service.ts';
import { createNetworkRouter } from './handler.ts';

export function createRouter(deps: FeatureDeps): Hono<any> {
  const service = new NetworkService(deps.stores.atomic, new ConsoleLogger(), deps.audit);
  return createNetworkRouter(service);
}
