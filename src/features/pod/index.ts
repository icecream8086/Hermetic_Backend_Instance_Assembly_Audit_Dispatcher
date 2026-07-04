import type { Hono } from 'hono';
import type { FeatureDeps, AppContext } from '../../core/deps.ts';
import { PodService } from '../../core/pod/service.ts';
import { createPodRouter } from './handler.ts';
import { QuotaService } from '../../core/quota/service.ts';

export function createRouter(deps: FeatureDeps): Hono<{ Variables: AppContext }> {
  const quotaService = new QuotaService(deps.stores.atomic, deps.audit);
  const podService = new PodService(deps.stores.atomic, deps.providers, undefined, deps.audit, deps.eventBus, quotaService);

  return createPodRouter(deps.permissionChecker, podService);
}
