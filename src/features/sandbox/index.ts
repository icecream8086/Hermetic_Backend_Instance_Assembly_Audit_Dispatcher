import type { Hono } from 'hono';
import { ConsoleLogger } from '../../core/audit/console-logger.ts';
import type { FeatureDeps } from '../../core/deps.ts';
import { SandboxService } from './sandbox.service.ts';
import { PodService } from '../../core/pod/service.ts';
import { createSandboxRouter } from './handler.ts';
import { createAtomicNetworkResolver } from '../../core/network/resolver.ts';
import { InstanceService } from '../../core/region/instance.ts';
import { QuotaService } from '../../core/quota/service.ts';

export function createRouter(deps: FeatureDeps): Hono<{ Variables: AppContext }> {
  const resolveNetwork = createAtomicNetworkResolver(deps.stores.atomic);
  const instanceService = new InstanceService(deps.stores.atomic);
  const quotaService = new QuotaService(deps.stores.atomic, deps.audit);
  const podService = new PodService(deps.stores.atomic, deps.providers, undefined, deps.audit, deps.eventBus, quotaService);
  const svc = new SandboxService(deps.stores.atomic, new ConsoleLogger(), podService, deps.providers, deps.eventBus, deps.audit, resolveNetwork, instanceService, deps.queueProducer);

  return createSandboxRouter(svc, deps.providers, deps.permissionChecker, podService);
}

// Base type hierarchy
export * from './base.ts';
export * from './types.ts';
export type * from './interfaces.ts';
export * as Assembly from './assembly/index.ts';
