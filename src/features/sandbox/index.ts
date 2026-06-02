import { Hono } from 'hono';
import { ConsoleLogger } from '../../core/logger/console-logger.ts';
import type { FeatureDeps } from '../../core/app.ts';
import { SandboxService } from './sandbox.service.ts';
import { createSandboxRouter } from './handler.ts';
import { PodResolver } from './assembly/pod-resolver.ts';
import { PodmanContainerGroupProvider } from '../../providers/podman/podman-group-provider.ts';
import { secureContainerGroupProvider } from '../../core/provider/security.ts';

export function createRouter(deps: FeatureDeps): Hono<any> {
  const svc = new SandboxService(deps.stores.atomic, new ConsoleLogger(), deps.providers.container, deps.providers, deps.eventBus, deps.audit);

  // Wire PodResolver with the Podman container group provider for local dev.
  // In production, a registered IContainerGroupProvider would be resolved from
  // the provider registry (currently no registry for group providers yet).
  const groupProvider = secureContainerGroupProvider(new PodmanContainerGroupProvider());
  const podResolver = new PodResolver(groupProvider);

  return createSandboxRouter(svc, podResolver, deps.permissionChecker);
}

// Base type hierarchy
export * from './base.ts';
export * from './types.ts';
export * from './interfaces.ts';
export * as Assembly from './assembly/index.ts';
