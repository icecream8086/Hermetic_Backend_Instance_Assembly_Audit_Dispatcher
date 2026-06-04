import { Hono } from 'hono';
import { ConsoleLogger } from '../../core/logger/console-logger.ts';
import type { FeatureDeps } from '../../core/app.ts';
import { SandboxService } from './sandbox.service.ts';
import { createSandboxRouter } from './handler.ts';
import { PodResolver } from './assembly/pod-resolver.ts';
import { createAtomicNetworkResolver } from '../../core/network/resolver.ts';
import { InstanceService } from '../../core/region/instance.ts';

export function createRouter(deps: FeatureDeps): Hono<any> {
  const resolveNetwork = createAtomicNetworkResolver(deps.stores.atomic);
  const instanceService = new InstanceService(deps.stores.atomic);
  const svc = new SandboxService(deps.stores.atomic, new ConsoleLogger(), deps.providers.container, deps.providers, deps.eventBus, deps.audit, resolveNetwork, instanceService);

  // Resolve container group provider from registry (platform-agnostic).
  // Falls back to Podman for local dev if no group provider is registered.
  const groupProvider = deps.providers.groupContainer;
  const podResolver = groupProvider ? new PodResolver(groupProvider) : undefined;

  return createSandboxRouter(svc, podResolver, deps.permissionChecker);
}

// Base type hierarchy
export * from './base.ts';
export * from './types.ts';
export * from './interfaces.ts';
export * as Assembly from './assembly/index.ts';
