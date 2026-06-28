import type { Hono } from 'hono';
import { ConsoleLogger } from '../../core/audit/console-logger.ts';
import type { FeatureDeps } from '../../core/deps.ts';
import { SandboxService } from './sandbox.service.ts';
import { createSandboxRouter } from './handler.ts';
import { createAtomicNetworkResolver } from '../../core/network/resolver.ts';
import { InstanceService } from '../../core/region/instance.ts';

export function createRouter(deps: FeatureDeps): Hono<any> {
  const resolveNetwork = createAtomicNetworkResolver(deps.stores.atomic);
  const instanceService = new InstanceService(deps.stores.atomic);
  // No global default — all provider resolution goes through per-instance resolveContainer(instanceId)
  const svc = new SandboxService(deps.stores.atomic, new ConsoleLogger(), null!, deps.providers, deps.eventBus, deps.audit, resolveNetwork, instanceService, deps.queueProducer);

  return createSandboxRouter(svc, deps.providers, deps.permissionChecker);
}

// Base type hierarchy
export * from './base.ts';
export * from './types.ts';
export type * from './interfaces.ts';
export * as Assembly from './assembly/index.ts';
