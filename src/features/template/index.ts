import { Hono } from 'hono';
import type { FeatureDeps } from '../../core/app.ts';
import { SandboxService } from '../sandbox/sandbox.service.ts';
import { ConsoleLogger } from '../../core/logger/console-logger.ts';
import { createTemplateRouter } from './handler.ts';
import type { IProviderRegistry } from '../../core/provider/interfaces.ts';
import { createAtomicNetworkResolver } from '../../core/network/resolver.ts';
import { InstanceService } from '../../core/region/instance.ts';

function createSandboxService(deps: FeatureDeps, providers: IProviderRegistry, providerName?: string): SandboxService {
  const entry = providerName ? providers.provider(providerName) : undefined;
  const container = entry?.container ?? providers.container;
  const resolveNetwork = createAtomicNetworkResolver(deps.stores.atomic);
  const instanceService = new InstanceService(deps.stores.atomic);
  return new SandboxService(deps.stores.atomic, new ConsoleLogger(), container, undefined, undefined, deps.audit, resolveNetwork, instanceService);
}

export function createRouter(deps: FeatureDeps): Hono<any> {
  // Default sandbox service uses the registry's default provider
  const defaultSvc = createSandboxService(deps, deps.providers);
  return createTemplateRouter(deps.stores.atomic, defaultSvc, deps.providers, deps.permissionChecker);
}
