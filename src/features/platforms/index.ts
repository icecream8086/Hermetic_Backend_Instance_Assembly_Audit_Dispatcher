import type { Hono } from 'hono';
import type { FeatureDeps } from '../../core/deps.ts';
import { createPlatformsRouter } from './handler.ts';

export function createRouter(deps: FeatureDeps): Hono<any> {
  return createPlatformsRouter(deps.providers, deps.stores.atomic);
}
