import { Hono } from 'hono';
import type { FeatureDeps } from '../../core/app.ts';
import { SandboxService } from '../sandbox/sandbox.service.ts';
import { ConsoleLogger } from '../../core/logger/console-logger.ts';
import { createTemplateRouter } from './handler.ts';
import type { IProviderRegistry } from '../../core/provider/interfaces.ts';

function createSandboxService(deps: FeatureDeps, providers: IProviderRegistry, providerName?: string): SandboxService {
  const entry = providerName ? providers.provider(providerName) : undefined;
  const container = entry?.container ?? providers.container;
  return new SandboxService(deps.stores.atomic, new ConsoleLogger(), container, undefined, undefined, deps.audit);
}

export function createRouter(deps: FeatureDeps): Hono<any> {
  // Default sandbox service uses the registry's default provider
  const defaultSvc = createSandboxService(deps, deps.providers);
  return createTemplateRouter(deps.stores.atomic, defaultSvc, deps.providers, deps.permissionChecker);
}
