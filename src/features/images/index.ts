import type { Hono } from 'hono';
import type { FeatureDeps } from '../../core/deps.ts';
import { createImagesRouter } from './handler.ts';

export function createRouter(deps: FeatureDeps): Hono<any> {
  return createImagesRouter(deps.providers);
}
