import type { Hono } from 'hono';
import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import type { IProviderRegistry } from '../../core/provider/interfaces.ts';
import type { FeatureDeps } from '../../core/deps.ts';
import { SandboxService } from '../sandbox/sandbox.service.ts';
import { PodService } from '../../core/pod/service.ts';
import { ConsoleLogger } from '../../core/audit/console-logger.ts';
import { createTemplateRouter } from './handler.ts';
import { createAtomicNetworkResolver } from '../../core/network/resolver.ts';
import { InstanceService } from '../../core/region/instance.ts';

/** Narrow dependency contract — only what the template feature actually uses. */
export interface TemplateDeps {
  stores: { atomic: IAtomicStore };
  providers: IProviderRegistry;
  permissionChecker?: FeatureDeps['permissionChecker'];
  audit?: IAuditWriter;
}

function createSandboxService(atomic: IAtomicStore, providers: IProviderRegistry, audit: IAuditWriter | undefined, providerName?: string): SandboxService {
  const entry = providerName ? providers.provider(providerName) : undefined;
  const container = entry?.container ?? null!;
  const resolveNetwork = createAtomicNetworkResolver(atomic);
  const instanceService = new InstanceService(atomic);
  const podService = new PodService(atomic, providers);
  return new SandboxService(atomic, new ConsoleLogger(), container, providers, undefined, audit, resolveNetwork, instanceService, undefined, podService);
}

export function createRouter(deps: TemplateDeps): Hono<{ Variables: AppContext }> {
  const defaultSvc = createSandboxService(deps.stores.atomic, deps.providers, deps.audit);
  return createTemplateRouter(deps.stores.atomic, defaultSvc, deps.providers, deps.permissionChecker);
}
