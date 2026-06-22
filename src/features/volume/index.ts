import { Hono } from 'hono';
import type { FeatureDeps } from '../../core/deps.ts';
import { ConsoleLogger } from '../../core/logger/console-logger.ts';
import { VolumeService } from './service.ts';
import { createVolumeRouter } from './handler.ts';

export function createRouter(deps: FeatureDeps): Hono<any> {
  const svc = new VolumeService(deps.stores.atomic, new ConsoleLogger(), deps.audit);
  return createVolumeRouter(svc);
}
