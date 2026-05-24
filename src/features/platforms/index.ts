import { Hono } from 'hono';
import type { FeatureDeps } from '../../core/app.ts';
import { createPlatformsRouter } from './handler.ts';

export function createRouter(deps: FeatureDeps): Hono<any> {
  return createPlatformsRouter(deps.providers);
}
