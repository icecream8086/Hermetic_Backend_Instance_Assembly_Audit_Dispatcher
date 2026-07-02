import type { Hono } from 'hono';
import type { FeatureDeps, AppContext } from '../../core/deps.ts';
import { ConsoleLogger } from '../../core/audit/console-logger.ts';
import { AppError } from '../../core/types.ts';
import { SecurityResourceService } from '../../core/security/service.ts';
import { createSecurityRouter } from './handler.ts';

export function createRouter(deps: FeatureDeps): Hono<{ Variables: AppContext }> {
  const securityService = new SecurityResourceService(deps.stores.atomic, new ConsoleLogger());
  if (!deps.s3ProviderResolver) throw new AppError(500, 'INTERNAL_ERROR', 's3ProviderResolver required');
  return createSecurityRouter({
    securityService,
    s3ProviderResolver: deps.s3ProviderResolver,
  });
}
