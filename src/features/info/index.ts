import { Hono } from 'hono';
import type { FeatureDeps } from '../../core/app.ts';
import { createInfoHandler } from './info.handler.ts';

export { ServerInfoSchema, type ServerInfo } from './info.schema.ts';

export function createRouter(deps: FeatureDeps): Hono<any> {
  return createInfoHandler(deps.stores);
}
