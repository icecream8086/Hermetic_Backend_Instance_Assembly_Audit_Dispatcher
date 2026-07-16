import type { FeatureDeps } from '../../core/deps.ts';
import { createStorageRouter } from './handler.ts';

export function createRouter(deps: FeatureDeps) {
  return createStorageRouter({
    s3ProviderResolver: deps.s3ProviderResolver!,
    ...(deps.permissionChecker ? { permissionChecker: deps.permissionChecker } : {}),
  });
}
