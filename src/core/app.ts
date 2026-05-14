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

export interface AppContext {
  stores: Stores;
  logRouter: ILogRouter;
  logger: ILogger;
}

export interface AppInstance {
  app: Hono<{ Variables: AppContext }>;
  stores: Stores;
  logRouter: LogRouter;
  dispose: () => Promise<void>;
}

/**
 * Assemble the application: wire stores, logger, middleware, and routes.
 */
export function createApp(config: AppConfig): AppInstance {
  // 1. Create storage adapters
  const stores = createStores(config.storage);

  // 2. Create logger infrastructure
  const logRouter = new LogRouter();

  // 3. Build Hono app
  const app = new Hono<{ Variables: AppContext }>();

  // 4. Apply global middleware
  app.use('*', cors());
  app.use('*', rateLimit({ windowMs: 60_000, maxRequests: 100 }));
  app.onError(globalErrorHandler);

  // 5. Bind per-request context
  // Routes populate c.var.logger by resolving from logRouter.
  // Default logger middleware example:
  // app.use('*', async (c, next) => { c.set('logger', logRouter.resolve(...)); await next(); });

  // 6. Export for route mounting
  return {
    app,
    stores,
    logRouter,
    dispose: async () => {
      logRouter.dispose();
    },
  };
}

/**
 * Helper: create the default system facility for use in app assembly.
 */
export const SYSTEM_FACILITY = createFacility('system');
