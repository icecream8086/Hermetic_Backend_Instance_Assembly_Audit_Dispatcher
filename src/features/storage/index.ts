import type { Hono } from 'hono';
import type { FeatureDeps, AppContext } from '../../core/deps.ts';
import { createStorageRouter } from './handler.ts';

export function createRouter(deps: FeatureDeps): Hono<{ Variables: AppContext }> {
  return createStorageRouter({
    s3ProviderResolver: deps.s3ProviderResolver!,
    ...(deps.permissionChecker ? { permissionChecker: deps.permissionChecker } : {}),
  });
}
