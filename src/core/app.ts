import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import { ok, fail } from './response.ts';
import type { AppConfig } from '../config/types.ts';
import { createStores } from './store/factory.ts';
import { globalErrorHandler } from './middleware/error-handler.ts';
import { rateLimit } from './middleware/rate-limit.ts';
import { createFacility } from './brand.ts';
import { getFeatures } from '../features/generated.ts';
import { createProviderRegistry } from './provider/factory.ts';
import { createTimerBackend } from './scheduler/factory.ts';
import { register as registerScheduler, startAll, stopAll } from './scheduler/registry.ts';
import { EventBus } from './event-bus/bus.ts';
import { EventLoop } from './event-bus/loop.ts';
import { SecretEncryption } from './auth/secret-encryption.ts';
import type { IAuditWriter, IAuditReader } from './audit/types.ts';
import type { Sandbox } from '../features/sandbox/types.ts';
import { createSandboxId } from '../features/sandbox/types.ts';
import type { ComputeInstance } from '../core/region/instance.ts';
import { WorkersAuditLogger, KvAuditLogger, HybridAuditLogger, createAuditRouter, setBootId } from './audit/index.ts';
import { LocalAuditLogger } from './audit/local-audit-logger.ts';
import { NoopAuditLogger } from './audit/noop-audit-logger.ts';
import { R2AuditLogger, type R2Bucket } from './audit/r2-logger.ts';
import { authz } from './middleware/auth.ts';
import { jsonDepthLimit } from './middleware/security.ts';
import { idempotency } from './middleware/idempotency.ts';
import { setActivePolicy } from './audit/log-policy.ts';
import { PermissionService } from '../features/permission/service.ts';
import { ConsoleLogger, setPanicHandler } from './audit/console-logger.ts';
import { DoBridge } from './event-bus/do-bridge.ts';
import { createWsRouter } from './ws/router.ts';
import { seedIfNeeded, ensureMacRules, seedPolicyLibrary } from './seed.ts';
import { RequestCachedAtomicStore } from './store/request-cache.ts';
import { formatDmesgLine } from './utils/dmesg.ts';
import { createMessageQueue } from '../queue/producer.ts';
import type { AppContext, FeatureDeps, AppInstance } from './deps.ts';
import { registerHealthCheck } from './events/health-check.ts';
import { registerImagePullHandler } from './events/image-pull.ts';
import { registerLogFetchHandler } from './events/log-fetch.ts';
import { SecretProvisioner, EciSecretBackend } from './security/secret-provisioner.ts';
import { AppError } from './types.ts';
import { z } from 'zod';
// Re-export for external consumers (index.ts, dev.ts, feature handlers)
export type { AppContext, FeatureDeps, AppInstance } from './deps.ts';

/**
 * Assemble the application: wire stores, logger, providers, event system, middleware, and routes.
 */
export async function createApp(config: AppConfig, platformBindings?: Record<string, unknown>): Promise<AppInstance> {
  // 0. Configure global panic handler — FATAL logs trigger isolate restart
  setPanicHandler((msg) => { throw new Error('KERNEL PANIC: ' + msg); });
  setBootId(crypto.randomUUID());

  // 1. Create storage adapters (KV, file, etc.)
  const stores = await createStores(config.storage, platformBindings);

  // 1b. 审计日志: 根据配置选择后端
  const auditBackend = config.audit?.backend ?? 'hybrid';
  let auditLogger: IAuditWriter & IAuditReader;
  switch (auditBackend) {
    case 'kv':
      auditLogger = new KvAuditLogger(stores.atomic);
      break;
    case 'workers':
      auditLogger = new WorkersAuditLogger();
      break;
    case 'r2': {
      const r2BucketRaw = platformBindings?.BLOB_STORE;
      if (!r2BucketRaw) {
        console.warn('[audit] R2 backend requested but BLOB_STORE binding not available — falling back to hybrid');
        auditLogger = new HybridAuditLogger(stores.atomic);
      } else {
        const r2Bucket = z.custom<R2Bucket>().parse(r2BucketRaw);
        const r2Logger = new R2AuditLogger(r2Bucket);
        r2Logger.startAutoFlush();
        auditLogger = r2Logger;
      }
      break;
    }
    case 'none':
      auditLogger = new NoopAuditLogger();
      break;
    case 'local':
      auditLogger = new LocalAuditLogger();
      break;
    case 'hybrid':
    default:
      // 统一日志器：本地/Workers 自动适配, 查询可用, 零外部依赖
      // 上线后可选配 Logpush→R2 + CloudflareLogReader 做长期归档
      auditLogger = new HybridAuditLogger(stores.atomic);
      break;
  }
  const audit: IAuditWriter = auditLogger;
  const auditReader: IAuditReader = auditLogger;

  // 2. Create secret encryption for credential at-rest protection
  const secretEncryption = SecretEncryption.fromEnv();
  if (secretEncryption) {
    console.log(formatDmesgLine('[app] Credential encryption enabled (AES-256-GCM)'));
  }

  // 2b. Create provider registry (backed by ComputeInstance entities)
  const providers = createProviderRegistry(config.provider, config.s3, stores.atomic, secretEncryption);

  // 3. Create queue producer for async task dispatch
  // In wrangler dev, Miniflare provides a local queue; in production, the TASK_QUEUE
  // binding routes messages to the Cloudflare Queues service.
  // When unavailable, createMessageQueue() returns a NoopMessageQueue — callers fall back to inline.
  const queueProducer = createMessageQueue(
    z.custom<Queue>().optional().parse(platformBindings?.TASK_QUEUE),
  );
  if (queueProducer.available) {
    console.log(formatDmesgLine('[app] Queue producer enabled (TASK_QUEUE)'));
  } else {
    console.log(formatDmesgLine('[app] Queue producer unavailable — falling back to EventLoop'));
  }

  // 4. Create timer backend (driven by SCHEDULER_BACKEND env var)
  const schedulerBackend = createTimerBackend(config.scheduler.backend, {
    doNamespace: z.custom<DurableObjectNamespace>().optional().parse(platformBindings?.ALARM_TIMER_DO),
    callbackUrl: config.scheduler.callbackUrl,
  });

  // 5. Create persistent event system
  const eventBus = new EventBus();
  const eventLoop = new EventLoop(
    eventBus,
    {
      intervalMs: 30000,
      batchSize: config.scheduler.batchSize,
      autoStart: true,
      onError: (err, ctx) => { console.error(formatDmesgLine(`[event-loop] ${ctx}: ${String(err instanceof Error ? err.message : err)}`)); },
    },
    schedulerBackend,
    stores.atomic,
  );

  registerScheduler('eventLoop', eventLoop);

  // 5b1. 健康检查事件 — 委托到 src/core/events/health-check.ts
  registerHealthCheck({
    stores: { atomic: stores.atomic },
    providers: { resolveContainer: providers.resolveContainer.bind(providers) },
    eventBus,
    eventLoop,
    audit,
    queueProducer,
  });

  // 5b2. 镜像拉取事件 — 委托到 src/core/events/image-pull.ts
  registerImagePullHandler({
    atomic: stores.atomic,
    providers,
    eventBus,
    queueProducer,
    ...(secretEncryption ? { secretEncryption } : {}),
  });

  // 5b3. 日志获取事件 — 异步缓存，最终一致性
  registerLogFetchHandler({
    atomic: stores.atomic,
    providers,
    eventBus,
  });

  // 5b4. 密钥下发 — SecretProvisioner 周期性同步到各平台后端
  const secretProvisioner = new SecretProvisioner([new EciSecretBackend()], stores.atomic);
  eventBus.on('secret:sync', async () => {
    await secretProvisioner.syncAll().catch(e => {
      console.error('[secret-provisioner] sync failed:', e instanceof Error ? e.message : String(e));
    });
    eventLoop.enqueuePriority({ type: 'secret:sync', payload: {} });
  });
  eventLoop.enqueuePriority({ type: 'secret:sync', payload: {} });

  // 5c. Load log policy into runtime
  try {
    const policyEntry = await stores.atomic.get<{ defaultLevel: string; auditLevel: string; facilities: { facility: string; level: string }[]; updatedAt: number }>('_sys:log-policy');
    if (policyEntry) setActivePolicy(policyEntry.value);
  } catch (err: unknown) { console.error('[init] Failed to load log policy:', err instanceof Error ? err.message : err); }

  // 5d. Bridge EventBus → WebSocket DOs for real-time notifications
  const notifDONamespace = z.custom<DurableObjectNamespace>().optional().parse(platformBindings?.NOTIFICATION_DO);
  if (notifDONamespace) {
    new DoBridge(eventBus, notifDONamespace);
  }

  // 6. Seed critical data synchronously — auth & permission groups must exist
  // before the first request can register a user, otherwise the first Root user
  // gets orphaned (no group membership → no capability bits → all 403).
  await ensureMacRules(stores.atomic);
  await seedPolicyLibrary(stores.atomic);

  // 7. Build Hono app

  // 7. Build Hono app
  const app = new Hono<{ Variables: AppContext }>();

  // 7. Apply global middleware (timing first = outermost, wrapping everything)

  app.use('*', async (c, next) => {
    const t0 = performance.now();
    await next();
    c.header('Server-Timing', `total;dur=${(performance.now() - t0).toFixed(2)}`);
  });
  app.use('*', async (c, next) => {
    const reqId = crypto.randomUUID().slice(0, 8);
    c.set('requestId', reqId);
    c.header('x-request-id', reqId);
    await next();
  });
  // Passive tick driver — workerd's setInterval can stall when the Worker
  // is idle between requests.  Every API call nudges the event loop tick
  // if the interval has elapsed, so frontend polling keeps GC running.
  let _lastPassiveTick = 0;
  app.use('*', async (_c, next) => {
    const now = Date.now();
    if (now - _lastPassiveTick > 30_000) {
      _lastPassiveTick = now;
      try { eventLoop.triggerTick(); } catch (e) {
        console.debug("noop");
      }
    }
    await next();
  });
  app.use('*', secureHeaders());
  app.use('*', cors({
    origin: config.cors?.origins ?? ['http://localhost:8086'],
    credentials: true,
  }));
  app.use('*', bodyLimit({ maxSize: 5 * 1024 * 1024 }));  // 5 MB
  app.use('*', jsonDepthLimit(10));                   // max JSON nesting
  app.use('*', rateLimit({
    burst: config.rateLimit?.burst ?? 100,
    intervalMs: config.rateLimit?.intervalMs ?? 60_000,
    ...(config.rateLimit?.enabled !== undefined ? { enabled: config.rateLimit.enabled } : {}),
    ...(config.rateLimit?.bypassIps ? { bypassIps: config.rateLimit.bypassIps } : {}),
    ...(config.rateLimit?.bypassToken ? { bypassToken: config.rateLimit.bypassToken } : {}),
  }));
  if (config.rateLimit?.enabled === false) {
    console.warn('[app] RATE LIMITING DISABLED — not suitable for production');
  }
  app.onError(globalErrorHandler);

  // 8. Inject context variables (with per-request atomic store cache)
  app.use('*', async (c, next) => {
    // Wrap atomic store with per-request cache to eliminate duplicate reads
    // across auth middleware, PermissionChecker, and RouteAclManager.
    const cachedAtomic = new RequestCachedAtomicStore(stores.atomic);
    c.set('stores', { ...stores, atomic: cachedAtomic });
    c.set('providers', providers);
    c.set('eventBus', eventBus);
    c.set('eventLoop', eventLoop);
    c.set('audit', audit);
    c.set('queueProducer', queueProducer);
    await next();
  });

  // Idempotency: replay protection for mutation endpoints (requires c.var.stores)
  app.use('*', idempotency());

  // 9. Dev-only: localhost → add user to the seed 'wheel' group (bypasses auth)
  // NOTE: This adds to wheel group ONLY. Does NOT elevate role to 'root'.

  // 10. Auth + route ACL middleware
  let permService: PermissionService | undefined;
  if (config.authz?.enabled !== false) {
    permService = new PermissionService(stores.atomic, new ConsoleLogger(), audit);
    const ps = permService;
    app.use('/api/*', authz({
      store: 'auto',
      audit,
      checkRouteAccess: async (method, path, userId) => {
        return ps.checkRouteAccess(method, path, userId);
      },
      publicPaths: [
        '/api/users/register',
        '/api/users/login',
        '/api/users/login-info',
        '/api/users/no-password-login',
        '/api/users/*/avatar',
        '/api/openapi.json',
      ],
    }));
  }

  // 10b. Load MAC rules after PermissionService is ready
  if (permService) {
    await permService.loadMacRules();
  }

  // 10c. Sudo endpoint — temporary privilege elevation for wheel members
  app.post('/api/sudo', async (c) => {
    if (!permService) return c.json({ error: 'Permission service unavailable' }, 503);
    const user = z.custom<{ id: string }>().optional().parse(c.var.currentUser);
    if (!user) return c.json({ error: 'Authentication required' }, 401);
    try {
      const expiry = await permService.grantTempElevation(user.id);
      return c.json(ok({ expiry, durationMs: 30 * 60 * 1000 }));
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 403);
    }
  });

  // 10d. 3-layer permission gate (DAC → Capability → MAC) — FILTER.INPUT
  // Runs after auth middleware sets userId; rejects at the first layer that fails.
  if (permService) {
    const { createPermissionGate } = await import('./middleware/permission-gate.ts');
    app.use('/api/*', createPermissionGate(
      { check: (params) => permService.check({ userId: params.actor, action: params.action, resource: params.resource }) },
      {
        skipPaths: [
          '/api/auth/login',
          '/api/auth/register',
          '/api/users/register',
          '/api/users/login',
          '/api/users/login-info',
          '/api/users/no-password-login',
          '/api/openapi.json',
          '/api/info',
        ],
      },
    ));
  }

  // 11. Tick trigger — DO Alarm fires POST /__scheduled, dev tools fire POST /__tick
  const tickHandler = async (c: { json: (data: Record<string, unknown>, status?: number) => Response }): Promise<Response> => {
    await eventLoop.triggerTick();
    const st = eventLoop.status();
    return c.json({ ok: true, queueSize: st.queueSize, processedCount: st.processedCount, running: st.running });
  };
  app.post('/__scheduled', tickHandler);
  app.post('/__tick', tickHandler);

  // 10. Migration endpoint (local only) — rebuild sharded user index from existing user keys
  app.post('/__admin/migrate-user-index', async (c) => {
    const { ids } = z.object({ ids: z.array(z.string()) }).parse(await c.req.json());
    const atomic = stores.atomic;
    const SHARDS = 16;
    const shards = Array.from({ length: SHARDS }, (_, i) => ({ key: 'user:idx:' + String(i), ids: new Set<string>() }));
    let count = 0;
    for (const id of ids) {
      const entry = await atomic.get<unknown>('user:' + id);
      if (entry !== null) {
        let hash = 5381;
        for (let i = 0; i < id.length; i++) { hash = ((hash << 5) + hash) + id.charCodeAt(i); hash |= 0; }
        const si = Math.abs(hash) % SHARDS;
        shards[si]?.ids.add(id);
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
      const parsed = z.object({ type: z.string(), payload: z.unknown().optional(), metadata: z.record(z.string(), z.unknown()).optional() }).parse(await c.req.json());
      const event = eventLoop.enqueueTrigger({ type: parsed.type, ...(parsed.payload !== undefined ? { payload: parsed.payload } : {}), ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}) });
      return c.json({ id: event.id }, 202);
    })
    .get('/loop/status', (c) => c.json(eventLoop.status()))
    .get('/loop/pending', (c) => c.json(eventLoop.pendingEvents()))
    .post('/loop/start', (c) => { eventLoop.start(); return c.json({ ok: true }); })
    .post('/loop/stop', (c) => { eventLoop.stop(); return c.json({ ok: true }); })
    .post('/loop/pause', (c) => { eventLoop.pause(); return c.json({ ok: true }); })
    .post('/loop/resume', (c) => { eventLoop.resume(); return c.json({ ok: true }); })
    .post('/loop/configure', async (c) => {
      const parsed = z.object({ intervalMs: z.number().optional(), autoStart: z.boolean().optional(), batchSize: z.number().optional(), maxQueueSize: z.number().optional() }).parse(await c.req.json());
      return c.json(eventLoop.configure({ ...(parsed.intervalMs !== undefined ? { intervalMs: parsed.intervalMs } : {}), ...(parsed.autoStart !== undefined ? { autoStart: parsed.autoStart } : {}), ...(parsed.batchSize !== undefined ? { batchSize: parsed.batchSize } : {}), ...(parsed.maxQueueSize !== undefined ? { maxQueueSize: parsed.maxQueueSize } : {}) }));
    });
  app.route('/api/events', events);

  // 11. OpenAPI specification endpoint
  // Serve from the pre-generated openapi.json at dev time; in production
  // the file is bundled by wrangler. Run `npm run docs:openapi` to regenerate.
  let openApiSpec: Record<string, unknown> | null = null;
  app.get('/api/openapi.json', async (c) => {
    if (!openApiSpec) {
      try {
        const mod = z.custom<{ default: Record<string, unknown> }>().parse(await import('../../openapi.json'));
        openApiSpec = mod.default;
      } catch (e) {
        return c.json({ error: 'OpenAPI spec not generated. Run: npm run docs:openapi' }, 503);
      }
    }
    return c.json(openApiSpec);
  });

  // 12. Mount audit log query endpoint
  app.route('/api/audit', createAuditRouter(auditReader));

  // 12b. Mount WebSocket upgrade routes
  const wsRouter = createWsRouter(platformBindings);
  app.route('/api/ws', wsRouter);

  // 13. Auto-register features from generated registry
  // Mount at both /path and /path/ since Hono's route() doesn't normalize
  // trailing slashes — /api/users matches but /api/users/ does not.
  const resolveS3Provider = async (bucketId: string): Promise<{ provider: import('./provider/s3.ts').IS3Provider; bucket: { name: string; endpoint: string; region: string } }> => {
    const s3Provider = providers.s3Account(bucketId);
    if (!s3Provider) throw new AppError(500, 'INTERNAL_ERROR', `S3 provider not found: ${bucketId}`);
    const account = config.s3.accounts.find(a => a.name === bucketId);
    return {
      provider: s3Provider,
      bucket: {
        name: account?.bucket ?? bucketId,
        endpoint: account?.endpoint ?? config.s3.endpoint ?? '',
        region: account?.defaultRegion ?? config.s3.region,
      },
    };
  };
  const featureDeps: FeatureDeps = { stores, providers, eventBus, eventLoop, audit, queueProducer, ...(permService ? { permissionChecker: z.custom<NonNullable<FeatureDeps['permissionChecker']>>().parse(permService) } : {}), ...(secretEncryption ? { secretEncryption } : {}), s3ProviderResolver: resolveS3Provider };
  // Mount each feature with and without trailing slash (Hono app.route() doesn't normalize)
  for (const feat of getFeatures()) {
    const router = feat.mount(featureDeps);
    app.route(feat.path, router);
    if (feat.path !== '/') {
      app.route(feat.path + '/', router);
    }
  }

  // 13b. Start all registered schedulers (idempotent — already-running are skipped).
  // Called after features mount so DagScheduler etc. are registered before startAll runs.
  startAll();

  // 12. Container logs — direct provider call (batch mode for ECI, Podman via Docker API)
  app.get('/api/sandboxes/:id/logs', async (c) => {
    const id = createSandboxId(c.req.param('id'));
    const user = c.var.currentUser;
    if (permService && user) {
      const result = await permService.check({ userId: user.id, action: 'read', resource: 'sandbox' });
      if (!result.allowed) return c.json(fail('FORBIDDEN', result.reason), 403);
    }

    const entry = await stores.atomic.get<Sandbox>('sandbox:' + id);
    if (!entry) return c.json(fail('SANDBOX_NOT_FOUND', 'Sandbox not found'), 404);
    const sandbox = entry.value;
    if (!sandbox.providerId) return c.json(fail('NO_PROVIDER', 'Sandbox has no provider resource'), 400);

    const containers = sandbox.containers;
    if (containers.length === 0) return c.json(fail('NO_CONTAINER', 'No containers in sandbox'), 400);
    const containerName = containers[0]?.name ?? '';
    const tailParam = c.req.query('tail');
    const tail = tailParam ? parseInt(tailParam) : undefined;
    const sinceParam = c.req.query('since');
    const since = sinceParam ? parseInt(sinceParam) : undefined;

    try {
      const logProvider = await providers.resolveContainer(sandbox.config.instanceId);
      const logResult = await logProvider.getLogs({
        region: sandbox.config.region,
        providerId: sandbox.providerId,
        containerName,
        ...(tail ? { limitBytes: tail } : {}),
        ...(since ? { sinceSeconds: since } : {}),
      });
      // Persist for future requests
      if (logResult.content) {
        try { await stores.atomic.set('log:' + id, { content: logResult.content, containerName, timestamp: logResult.timestamp, fetchedAt: Date.now() }, null); } catch (e) {
          console.debug("noop");
        }
      }
      return c.json(ok({ content: logResult.content || '', containerName, timestamp: logResult.timestamp }));
    } catch (e: unknown) {
      // Try cached
      const cached = await stores.atomic.get<{ content: string; containerName: string; fetchedAt: number }>('log:' + id);
      if (cached) return c.json(ok({ content: cached.value.content, containerName: cached.value.containerName, cached: true }));
      const errMsg = e instanceof Error ? e.message : String(e);
      return c.json(fail('LOGS_UNAVAILABLE', errMsg || 'Logs unavailable'), 502);
    }
  });

  // Optional: WebSocket streaming via DO for Podman live tail
  const logStreamNs = z.custom<DurableObjectNamespace>().optional().parse(platformBindings?.LOG_STREAM_DO);
  if (logStreamNs) {
    app.get('/api/sandboxes/:id/logs/stream', async (c) => {
      const id = createSandboxId(c.req.param('id'));
      const entry = await stores.atomic.get<Sandbox>('sandbox:' + id);
      if (!entry) return c.json(fail('SANDBOX_NOT_FOUND', 'Sandbox not found'), 404);
      const sandbox = entry.value;
      if (!sandbox.providerId) return c.json(fail('NO_PROVIDER', 'Sandbox has no provider resource'), 400);

      const instanceId = sandbox.config.instanceId;
      let endpoint = 'http://127.0.0.1:8080/v1.24';
      if (instanceId) {
        const instEntry = await stores.atomic.get<ComputeInstance>('instance:' + instanceId);
        if (instEntry) endpoint = instEntry.value.endpoint || endpoint;
      }

      const stub = logStreamNs.get(logStreamNs.idFromName('logstream:' + id));
      const tailQ = c.req.query('tail');
      const sinceQ = c.req.query('since');
      const qs = new URLSearchParams({ providerId: sandbox.providerId, provider: 'podman', endpoint,
        containerName: sandbox.containers[0]?.name ?? '',
        ...(tailQ ? { tail: tailQ } : {}),
        ...(sinceQ ? { since: sinceQ } : {}),
      });
      return stub.fetch(new URL(`/logs?${qs.toString()}`, 'https://do/'), c.req.raw);
    });
  }

  // 13. Export
  return {
    app,
    stores,
    providers,
    eventBus,
    eventLoop,
    audit,
    // eslint-disable-next-line @typescript-eslint/require-await -- interface contract requires Promise<T>
    dispose: async () => {
      stopAll();
    },
    seed: () => seedIfNeeded(stores.atomic),
  };
}

export const SYSTEM_FACILITY = createFacility('system');
