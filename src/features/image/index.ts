import { Hono } from 'hono';
import type { FeatureDeps } from '../../core/app.ts';
import { createImageRouter } from './handler.ts';

export function createRouter(deps: FeatureDeps): Hono<any> {
  return createImageRouter(deps.permissionChecker);
}
