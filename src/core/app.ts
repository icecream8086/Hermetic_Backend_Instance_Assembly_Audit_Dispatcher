import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppConfig } from '../config/types.ts';
import type { Stores } from './store/interfaces.ts';
import { createStores } from './store/factory.ts';
import type { ILogRouter, ILogger } from './logger/interfaces.ts';
import { LogRouter } from './logger/router.ts';
import { globalErrorHandler } from './middleware/error-handler.ts';
import { rateLimit } from './middleware/rate-limit.ts';
import { createFacility } from './brand.ts';
import { createInfoHandler } from '../features/info/info.handler.ts';
import type { IProviderRegistry } from './provider/interfaces.ts';
import { createProviderRegistry } from './provider/factory.ts';
import type { ProviderCredentials } from './provider/factory.ts';

export interface AppContext {
  stores: Stores;
  logRouter: ILogRouter;
  logger: ILogger;
  providers: IProviderRegistry;
}

export interface AppInstance {
  app: Hono<{ Variables: AppContext }>;
  stores: Stores;
  logRouter: ILogRouter;
  providers: IProviderRegistry;
  dispose: () => Promise<void>;
}

// ─── Credentials resolvers ───

function resolveCredentials(): ProviderCredentials {
  const aliAkId = process.env['ALIBABA_ACCESS_KEY_ID'];
  const aliAkSecret = process.env['ALIBABA_ACCESS_KEY_SECRET'];
  const cfToken = process.env['CF_API_TOKEN'];

  return {
    ...(aliAkId && aliAkSecret ? { alibaba: { accessKeyId: aliAkId, accessKeySecret: aliAkSecret } } : {}),
    ...(cfToken ? { cloudflare: { apiToken: cfToken } } : {}),
  };
}

/**
 * Assemble the application: wire stores, logger, providers, middleware, and routes.
 */
export function createApp(config: AppConfig, platformBindings?: Record<string, unknown>): AppInstance {
  // 1. Create storage adapters (KV, file, etc.)
  const stores = createStores(config.storage, platformBindings);

  // 2. Create logger infrastructure
  const logRouter = new LogRouter();

  // 3. Create container provider implementations
  const credentials = resolveCredentials();
  const providers = createProviderRegistry(config.provider, credentials);

  // 4. Build Hono app
  const app = new Hono<{ Variables: AppContext }>();

  // 5. Apply global middleware
  app.use('*', cors());
  app.use('*', rateLimit({ windowMs: 60_000, maxRequests: 100 }));
  app.onError(globalErrorHandler);

  // 6. Mount feature routes
  app.route('/', createInfoHandler());

  // 8. Export for route mounting
  return {
    app,
    stores,
    logRouter,
    providers,
    dispose: async () => {
      logRouter.dispose();
    },
  };
}

/**
 * Helper: create the default system facility for use in app assembly.
 */
export const SYSTEM_FACILITY = createFacility('system');
