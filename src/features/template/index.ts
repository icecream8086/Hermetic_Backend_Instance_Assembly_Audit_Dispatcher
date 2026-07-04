import type { Hono } from 'hono';
import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { IProviderRegistry } from '../../core/provider/interfaces.ts';
import type { FeatureDeps } from '../../core/deps.ts';
import { PodService } from '../../core/pod/service.ts';
import { createTemplateRouter } from './handler.ts';

/** Narrow dependency contract — only what the template feature actually uses. */
export interface TemplateDeps {
  stores: { atomic: IAtomicStore };
  providers: IProviderRegistry;
  permissionChecker?: FeatureDeps['permissionChecker'];
}

export function createRouter(deps: TemplateDeps): Hono<{ Variables: AppContext }> {
  const podSvc = new PodService(deps.stores.atomic, deps.providers);
  return createTemplateRouter(deps.stores.atomic, podSvc, deps.providers, deps.permissionChecker);
}
