import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppConfig } from '../config/types.ts';
import type { Stores } from './store/interfaces.ts';
import { createStores } from './store/factory.ts';
import type { ILogRouter } from './logger/interfaces.ts';
import { LogRouter } from './logger/router.ts';
import { globalErrorHandler } from './middleware/error-handler.ts';
import { rateLimit } from './middleware/rate-limit.ts';
import { createFacility } from './brand.ts';
import { getFeatures } from '../features/generated.ts';
import type { IProviderRegistry } from './provider/interfaces.ts';
import { createProviderRegistry } from './provider/factory.ts';
import type { ProviderCredentials } from './provider/factory.ts';
import { createTimerBackend } from './scheduler/factory.ts';
import { EventBus } from './event-bus/bus.ts';
import { EventLoop } from './event-bus/loop.ts';
import type { EventLoopConfig, TriggerEventInput } from './event-bus/types.ts';
import type { IAuditWriter, IAuditReader } from './audit/types.ts';
import { WorkersAuditLogger, createAuditRouter } from './audit/index.ts';

export interface AppContext {
  stores: Stores;
  logRouter: ILogRouter;
  providers: IProviderRegistry;
  eventBus: EventBus;
  eventLoop: EventLoop;
  audit: IAuditWriter;
}

/** Shared dependencies injected into every feature's createRouter(). */
export interface FeatureDeps {
  stores: Stores;
  logRouter: ILogRouter;
  providers: IProviderRegistry;
  eventBus: EventBus;
  eventLoop: EventLoop;
  audit: IAuditWriter;
}

export interface AppInstance {
  app: Hono<{ Variables: AppContext }>;
  stores: Stores;
  logRouter: ILogRouter;
  providers: IProviderRegistry;
  eventBus: EventBus;
  eventLoop: EventLoop;
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
 * Assemble the application: wire stores, logger, providers, event system, middleware, and routes.
 */
export function createApp(config: AppConfig, platformBindings?: Record<string, unknown>): AppInstance {
  // 1. Create storage adapters (KV, file, etc.)
  const stores = createStores(config.storage, platformBindings);

  // 1b. 审计日志: console → Workers Logs (纯转发，不本地缓存)
  const auditLogger = new WorkersAuditLogger();
  const audit: IAuditWriter = auditLogger;
  const auditReader: IAuditReader = auditLogger;

  // 2. Create logger infrastructure
  const logRouter = new LogRouter();

  // 3. Create container provider implementations
  const credentials = resolveCredentials();
  const providers = createProviderRegistry(config.provider, credentials);

  // 4. Create timer backend (driven by SCHEDULER_BACKEND env var)
  const schedulerBackend = createTimerBackend(config.scheduler.backend, {
    doNamespace: platformBindings?.['ALARM_TIMER_DO'] as DurableObjectNamespace | undefined,
    callbackUrl: config.scheduler.callbackUrl,
  });

  // 5. Create persistent event system
  const eventBus = new EventBus();
  const eventLoop = new EventLoop(
    eventBus,
    {
      intervalMs: config.scheduler.intervalMs,
      batchSize: config.scheduler.batchSize,
      autoStart: true,
    } as Partial<EventLoopConfig>,
    schedulerBackend,
    stores.atomic,
  );

  // 6. Build Hono app
  const app = new Hono<{ Variables: AppContext }>();

  // 7. Apply global middleware (timing first = outermost, wrapping everything)
  app.use('*', async (c, next) => {
    const t0 = performance.now();
    await next();
    c.header('Server-Timing', `total;dur=${(performance.now() - t0).toFixed(2)}`);
  });
  app.use('*', cors());
  app.use('*', rateLimit({ windowMs: 60_000, maxRequests: 100 }));
  app.onError(globalErrorHandler);

  // 8. Inject context variables
  app.use('*', async (c, next) => {
    c.set('stores', stores);
    c.set('logRouter', logRouter);
    c.set('providers', providers);
    c.set('eventBus', eventBus);
    c.set('eventLoop', eventLoop);
    c.set('audit', audit);
    await next();
  });

  // 9. DO alarm callback route
  app.post('/__scheduled', (c) => {
    eventLoop.triggerTick();
    return c.json({ ok: true, queueSize: eventLoop.size });
  });

  // 10. Migration endpoint (local only) — rebuild sharded user index from existing user keys
  app.post('/__admin/migrate-user-index', async (c) => {
    const { ids } = await c.req.json<{ ids: string[] }>();
    const atomic = stores.atomic;
    const SHARDS = 16;
    const shards = Array.from({ length: SHARDS }, (_, i) => ({ key: 'user:idx:' + i, ids: new Set<string>() }));
    let count = 0;
    for (const id of ids) {
      const entry = await atomic.get<unknown>('user:' + id);
      if (entry !== null) {
        let hash = 5381;
        for (let i = 0; i < id.length; i++) { hash = ((hash << 5) + hash) + id.charCodeAt(i); hash |= 0; }
        const si = Math.abs(hash) % SHARDS;
        shards[si]!.ids.add(id);
        count++;
      }
    }
    if (count === 0) return c.json({ migrated: 0 });
    for (const s of shards) {
      const current = await atomic.get<string[]>(s.key);
      await atomic.set(s.key, [...s.ids], current?.version ?? null);
    }
    return c.json({ migrated: count });
  });

  // 11. Event management API routes
  const events = new Hono<{ Variables: AppContext }>()
    .post('/', async (c) => {
      const input = await c.req.json<TriggerEventInput>();
      const event = eventLoop.enqueueTrigger(input);
      return c.json({ id: event.id }, 202);
    })
    .get('/loop/status', (c) => c.json(eventLoop.status()))
    .post('/loop/start', (c) => { eventLoop.start(); return c.json({ ok: true }); })
    .post('/loop/stop', (c) => { eventLoop.stop(); return c.json({ ok: true }); })
    .post('/loop/pause', (c) => { eventLoop.pause(); return c.json({ ok: true }); })
    .post('/loop/resume', (c) => { eventLoop.resume(); return c.json({ ok: true }); })
    .post('/loop/configure', async (c) => {
      const body = await c.req.json<Partial<EventLoopConfig>>();
      return c.json(eventLoop.configure(body));
    });
  app.route('/api/events', events);

  // 11. Mount audit log query endpoint
  app.route('/api/audit', createAuditRouter(auditReader));

  // 12. Auto-register features from generated registry
  // Mount at both /path and /path/ since Hono's route() doesn't normalize
  // trailing slashes — /api/users matches but /api/users/ does not.
  const featureDeps: FeatureDeps = { stores, logRouter, providers, eventBus, eventLoop, audit };
  for (const feat of getFeatures()) {
    const router = feat.mount(featureDeps);
    app.route(feat.path, router);
    if (feat.path !== '/') {
      app.route(feat.path + '/', router);
    }
  }

  // 12. Export
  return {
    app,
    stores,
    logRouter,
    providers,
    eventBus,
    eventLoop,
    dispose: async () => {
      eventLoop.stop();
      logRouter.dispose();
    },
  };
}

export const SYSTEM_FACILITY = createFacility('system');
