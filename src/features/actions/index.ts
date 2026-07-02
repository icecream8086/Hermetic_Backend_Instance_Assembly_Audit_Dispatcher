import type { Hono } from 'hono';
import type { FeatureDeps } from '../../core/deps.ts';
import { createActionsRouter } from './handler.ts';

export function createRouter(deps: FeatureDeps): Hono<{ Variables: AppContext }> {
  return createActionsRouter(deps);
}
