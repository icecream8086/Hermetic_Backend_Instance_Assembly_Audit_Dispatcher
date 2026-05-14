import { createApp, SYSTEM_FACILITY } from './core/app.ts';
import { loadConfig } from './config/env.ts';
import { ExampleService } from './features/example/example.service.ts';
import { ExampleHandler } from './features/example/example.handler.ts';
import { createExampleRouter } from './features/example/example.router.ts';

// Load environment-based configuration
const config = loadConfig();
const { app, stores, logRouter } = createApp(config);

// Wire feature dependencies
const exampleService = new ExampleService(
  stores.atomic,
  logRouter.resolve(SYSTEM_FACILITY),
);
const exampleHandler = new ExampleHandler(exampleService);

// Mount feature routers
app.route('/api/orders', createExampleRouter(exampleHandler));

// Export for hosting environment (Node, Bun, Cloudflare Workers, etc.)
export default app;
