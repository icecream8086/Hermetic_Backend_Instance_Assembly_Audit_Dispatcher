import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import { fail } from './response.ts';
import type { AppConfig } from '../config/types.ts';
import type { Stores } from './store/interfaces.ts';
import { createStores } from './store/factory.ts';
import { globalErrorHandler } from './middleware/error-handler.ts';
import { rateLimit } from './middleware/rate-limit.ts';
import { createFacility } from './brand.ts';
import { getFeatures } from '../features/generated.ts';
import type { IProviderRegistry } from './provider/interfaces.ts';
import { createProviderRegistry } from './provider/factory.ts';
import { createTimerBackend } from './scheduler/factory.ts';
import { EventBus } from './event-bus/bus.ts';
import { EventLoop } from './event-bus/loop.ts';
import { CredentialService } from './auth/credential.ts';
import { SecretEncryption } from './auth/secret-encryption.ts';
import type { EventLoopConfig, TriggerEventInput } from './event-bus/types.ts';
import type { IAuditWriter, IAuditReader } from './audit/types.ts';
import type { Sandbox } from '../features/sandbox/types.ts';
import { SandboxStatus, createSandboxId } from '../features/sandbox/types.ts';
import type { ComputeInstance } from '../core/region/instance.ts';
import { WorkersAuditLogger, KvAuditLogger, createAuditRouter } from './audit/index.ts';
import { LocalAuditLogger } from './audit/local-audit-logger.ts';
import { NoopAuditLogger } from './audit/noop-audit-logger.ts';
import { authz } from './middleware/auth.ts';
import { jsonDepthLimit } from './middleware/security.ts';
import { setActivePolicy } from './logger/log-policy.ts';
import { PermissionService } from '../features/permission/service.ts';
import { ConsoleLogger, setPanicHandler } from './logger/console-logger.ts';
import { DoBridge } from './event-bus/do-bridge.ts';
import { createWsRouter } from './ws/router.ts';
import { seedIfNeeded, ensureMacRules } from './seed.ts';
import { RequestCachedAtomicStore } from './store/request-cache.ts';
import { formatDmesgLine } from './utils/dmesg.ts';

export interface AppContext {
  stores: Stores;
  providers: IProviderRegistry;
  eventBus: EventBus;
  eventLoop: EventLoop;
  audit: IAuditWriter;
  requestId?: string;
  permissionChecker?: FeatureDeps['permissionChecker'];
}

/** Shared dependencies injected into every feature's createRouter(). */
export interface FeatureDeps {
  stores: Stores;
  providers: IProviderRegistry;
  eventBus: EventBus;
  eventLoop: EventLoop;
  audit: IAuditWriter;
  /** Optional action+resource level permission checker (PermissionService.check compatible). */
  permissionChecker?: { check(params: { userId: string; action: string; resource: string; ip?: string; resourceOwnerId?: string }): Promise<{ allowed: boolean; reason: string }> };
  /** AES-256-GCM envelope encryption for credential secrets at rest. */
  secretEncryption?: import('./auth/secret-encryption.ts').SecretEncryption;
}

export interface AppInstance {
  app: Hono<{ Variables: AppContext }>;
  stores: Stores;
  providers: IProviderRegistry;
  eventBus: EventBus;
  eventLoop: EventLoop;
  dispose: () => Promise<void>;
  /** Run background seeding (policy lib, default instance, templates). Use with ctx.waitUntil() in Worker mode. */
  seed: () => Promise<void>;
}

/**
 * Assemble the application: wire stores, logger, providers, event system, middleware, and routes.
 */
export async function createApp(config: AppConfig, platformBindings?: Record<string, unknown>): Promise<AppInstance> {
  // 0. Configure global panic handler — FATAL logs trigger isolate restart
  setPanicHandler((msg) => { throw new Error('KERNEL PANIC: ' + msg); });

  // 1. Create storage adapters (KV, file, etc.)
  const stores = await createStores(config.storage, platformBindings);

  // 1b. 审计日志: 根据配置选择后端
  const auditBackend = config.audit?.backend ?? (config.storage.stateBackend === 'file' ? 'local' : 'workers');
  let auditLogger: IAuditWriter & IAuditReader;
  switch (auditBackend) {
    case 'kv':
      auditLogger = new KvAuditLogger(stores.atomic);
      break;
    case 'workers':
      auditLogger = new WorkersAuditLogger();
      break;
    case 'none':
      auditLogger = new NoopAuditLogger();
      break;
    case 'local':
    default:
      auditLogger = new LocalAuditLogger();
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
      intervalMs: 30000,
      batchSize: config.scheduler.batchSize,
      autoStart: true,
      onError: (err, ctx) => console.error(formatDmesgLine(`[event-loop] ${ctx}: ${err instanceof Error ? err.message : err}`)),
    } as Partial<EventLoopConfig>,
    schedulerBackend,
    stores.atomic,
  );

  // 5b. 健康检查事件：每 tick 查询 provider 实时状态，可配重试次数，-1 为白名单
  eventBus.on('health:check', async () => {
    try {
      const idx = await stores.atomic.get<string[]>('sandbox:ids');
      if (!idx || !providers.container.getStatus) return;
      for (const sid of idx.value) {
        try {
          const entry = await stores.atomic.get<Sandbox>(`sandbox:${sid}`);
          if (!entry || entry.value.status === SandboxStatus.Deleted) continue;
          // Stopped 超过 2 tick 的沙箱 → 回收
          if (entry.value.status === SandboxStatus.Stopped) {
            const stoppedDuration = Date.now() - entry.value.updatedAt;
            if (stoppedDuration > 60_000) { // 停止超过 60 秒才回收
              await stores.atomic.set(`sandbox:${sid}`, { ...entry.value, status: SandboxStatus.Deleted, updatedAt: Date.now() }, entry.version);
              const idxEntry = await stores.atomic.get<string[]>('sandbox:ids');
              if (idxEntry) await stores.atomic.set('sandbox:ids', idxEntry.value.filter((i: string) => i !== sid), idxEntry.version);
              console.log(formatDmesgLine(`sandbox DELETED (stopped-gc) id=${sid} name=${entry.value.name} provider=${entry.value.providerId ?? ''} containers=${entry.value.containers.length} uptime=${Date.now() - entry.value.createdAt}ms`));
            }
            continue;
          }
          const maxRetries = entry.value.config.healthMaxRetries ?? 3;
          if (maxRetries === -1) continue;
          const runtime = await providers.container.getStatus(entry.value.providerId ?? sid);
          if (!runtime) {
            // Provider 已无此容器 → 标记已清理并从索引移除
            for (let attempt = 0; attempt < 3; attempt++) {
              const latest = await stores.atomic.get<Sandbox>(`sandbox:${sid}`);
              if (!latest) break;
              const ver = await stores.atomic.set(`sandbox:${sid}`, { ...latest.value, status: SandboxStatus.Deleted, updatedAt: Date.now() }, latest.version);
              if (!ver) continue;
              const idxEntry = await stores.atomic.get<string[]>('sandbox:ids');
              if (idxEntry) await stores.atomic.set('sandbox:ids', idxEntry.value.filter((i: string) => i !== sid), idxEntry.version);
              console.log(formatDmesgLine(`sandbox DELETED (provider-gone) id=${sid} name=${entry.value.name} provider=${entry.value.providerId ?? ''} containers=${entry.value.containers.length} uptime=${Date.now() - entry.value.createdAt}ms`));
              break;
            }
            continue;
          }
          const allHealthy = runtime.containers.every(cc => cc.alive);
          const failKey = `health:fails:${sid}`;
          if (allHealthy) {
            const failEntry = await stores.atomic.get<number>(failKey);
            if (failEntry) await stores.atomic.set(failKey, 0, failEntry.version);
          } else {
            const failEntry = await stores.atomic.get<number>(failKey);
            const fails = (failEntry?.value ?? 0) + 1;
            await stores.atomic.set(failKey, fails, failEntry?.version ?? null);
            if (fails >= maxRetries) {
              await providers.container.delete({ region: entry.value.config.region, providerId: entry.value.providerId ?? sid });
              for (let attempt = 0; attempt < 3; attempt++) {
                const latest = await stores.atomic.get<Sandbox>(`sandbox:${sid}`);
                if (!latest) break;
                const ver = await stores.atomic.set(`sandbox:${sid}`, { ...latest.value, status: SandboxStatus.Deleted, updatedAt: Date.now() }, latest.version);
                if (!ver) continue;
                const idxEntry = await stores.atomic.get<string[]>('sandbox:ids');
                if (idxEntry) await stores.atomic.set('sandbox:ids', idxEntry.value.filter((i: string) => i !== sid), idxEntry.version);
                console.log(formatDmesgLine(`sandbox DELETED (unhealthy-gc) id=${sid} name=${entry.value.name} provider=${entry.value.providerId ?? ''} containers=${entry.value.containers.length} uptime=${Date.now() - entry.value.createdAt}ms`));
                break;
              }
            }
          }
        } catch (e) { console.error(`[health] check error ${sid}:`, e instanceof Error ? e.message : e); }
      }

      // Instance heartbeat timeout — 120s no heartbeat → offline
      const instIdx = await stores.atomic.get<string[]>('instance:ids');
      if (instIdx) {
        const now = Date.now();
        for (const iid of instIdx.value) {
          try {
            const instEntry = await stores.atomic.get<any>('instance:' + iid);
            if (!instEntry?.value || instEntry.value.status !== 'online') continue;
            if (instEntry.value.updatedAt && (now - instEntry.value.updatedAt > 120_000)) {
              await stores.atomic.set('instance:' + iid, { ...instEntry.value, status: 'offline', updatedAt: now }, instEntry.version);
            }
          } catch { /* skip problematic instances */ }
        }
      }

      // Bucket key rotation — rotate expired auto-generated S3 access keys
      const BINDING_INDEX_KEY = 'bucket-key:ids';
      const BINDING_PREFIX = 'bucket-key:';
      const bIdx = await stores.atomic.get<string[]>(BINDING_INDEX_KEY);
      if (bIdx) {
        for (const sid of bIdx.value) {
          try {
            const entry = await stores.atomic.get<any>(BINDING_PREFIX + sid);
            if (!entry?.value || entry.value.expiresAt > Date.now()) continue;
            const binding = entry.value;
            const ak = binding.accessKeyId;
            const sk = Array.from(crypto.getRandomValues(new Uint8Array(32)))
              .map((b: number) => b.toString(16).padStart(2, '0'))
              .join('');
            binding.secretValue = `${ak}:${sk}`;
            binding.version++;
            binding.expiresAt = Date.now() + (binding.rotationIntervalMs ?? 24 * 60 * 60 * 1000);
            await stores.atomic.set(BINDING_PREFIX + sid, binding, entry.version);
          } catch { /* skip problematic bindings */ }
        }
      }
    } finally {
      // 重新入队，保证每 tick 执行一次
      eventLoop.enqueuePriority({ type: 'health:check', payload: {} });
    }
  });
  // 触发首次健康检查
  eventLoop.enqueuePriority({ type: 'health:check', payload: {} });

  // 5b2. 镜像拉取事件：从事件循环队列中异步处理
  eventBus.on('image.pull', async (event) => {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (!payload) return;
    const { taskId, image, instanceId, clusterId, credentialRef, registryCredential } = payload as {
      taskId?: string; image?: string; instanceId?: string; clusterId?: string;
      credentialRef?: string; registryCredential?: { server: string; userName: string; password: string };
    };
    if (!taskId || !image) return;

    const entry = await stores.atomic.get<any>('pull-task:' + taskId);
    if (!entry) return;
    const taskBase = { id: taskId, repositoryId: entry.value.repositoryId, image, createdAt: entry.value.createdAt };

    try {
      const imgProvider = instanceId ? await providers.resolveImage(instanceId as any) : providers.image;

      // Resolve registry credentials from credential module if credentialRef is set
      let credArg: string | { server: string; userName: string; password: string } | undefined = clusterId;
      if (credentialRef) {
        const credSvc = new CredentialService(stores.atomic, secretEncryption);
        const managed = await credSvc.findByName(credentialRef);
        if (managed?.registryCredentials?.length) {
          // Pass first registry credential to pull (ECI supports one per pull via pull param,
          // additional ones were baked into the provider at construction time)
          credArg = { server: managed.registryCredentials[0]!.server, userName: managed.registryCredentials[0]!.userName, password: managed.registryCredentials[0]!.password };
        }
      } else if (registryCredential) {
        credArg = registryCredential;
      }

      const info = await imgProvider.pull(image, credArg as any);
      await stores.atomic.set('pull-task:' + taskId, {
        ...taskBase, status: 'completed', result: { id: info.id, tags: [...info.tags] }, completedAt: Date.now(),
      }, entry.version);
    } catch (e: any) {
      console.error(`[pull-task] ${taskId} failed:`, e.message);
      await stores.atomic.set('pull-task:' + taskId, {
        ...taskBase, status: 'failed', error: e.message, failedAt: Date.now(),
      }, entry.version);
    }
  });

  // 5c. Load log policy into runtime (non-blocking)
  stores.atomic.get<any>('_sys:log-policy').then(entry => {
    if (entry) setActivePolicy(entry.value);
  }).catch((err: unknown) => console.error('[init] Failed to load log policy:', err instanceof Error ? err.message : err));

  // 5d. Bridge EventBus → WebSocket DOs for real-time notifications
  const notifDONamespace = platformBindings?.['NOTIFICATION_DO'] as DurableObjectNamespace | undefined;
  if (notifDONamespace) {
    new DoBridge(eventBus, notifDONamespace);
  }

  // 6. Deferred background seeding — policy lib, default instance, templates.
  // Shipping seeds to ctx.waitUntil() so first request isn't blocked.
  // MAC rules are the only seed data that must exist before auth runs.
  await ensureMacRules(stores.atomic);

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
  app.use('*', secureHeaders());
  app.use('*', cors());
  app.use('*', bodyLimit({ maxSize: 5 * 1024 * 1024 }));  // 5 MB
  app.use('*', jsonDepthLimit(10));                   // max JSON nesting
  app.use('*', rateLimit({ windowMs: 60_000, maxRequests: 100 }));
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
    await next();
  });

  // 9. Dev-only: localhost → add user to the seed 'wheel' group (bypasses auth)
  // NOTE: This adds to wheel group ONLY. Does NOT elevate role to 'root'.

  // 10. Auth + route ACL middleware
  let permService: PermissionService | undefined;
  if (config.authz?.enabled !== false) {
    permService = new PermissionService(stores.atomic, new ConsoleLogger(), audit);
    app.use('/api/*', authz({
      store: 'auto',
      audit,
      checkRouteAccess: async (method, path, userId) => {
        return permService!.checkRouteAccess(method, path, userId);
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
    const user = c.var?.currentUser as { id: string } | undefined;
    if (!user) return c.json({ error: 'Authentication required' }, 401);
    try {
      const expiry = await permService.grantTempElevation(user.id);
      return c.json({ ok: true, data: { expiry, durationMs: 30 * 60 * 1000 } });
    } catch (e: any) {
      return c.json({ error: e.message }, 403);
    }
  });

  // 11. DO alarm callback route — DO Alarm fires POST /__scheduled → triggerTick()
  app.post('/__scheduled', async (c) => {
    await eventLoop.triggerTick();
    const st = eventLoop.status();
    return c.json({ ok: true, queueSize: st.queueSize, processedCount: st.processedCount, running: st.running });
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
    .get('/loop/pending', (c) => c.json(eventLoop.pendingEvents()))
    .post('/loop/start', (c) => { eventLoop.start(); return c.json({ ok: true }); })
    .post('/loop/stop', (c) => { eventLoop.stop(); return c.json({ ok: true }); })
    .post('/loop/pause', (c) => { eventLoop.pause(); return c.json({ ok: true }); })
    .post('/loop/resume', (c) => { eventLoop.resume(); return c.json({ ok: true }); })
    .post('/loop/configure', async (c) => {
      const body = await c.req.json<Partial<EventLoopConfig>>();
      return c.json(eventLoop.configure(body));
    });
  app.route('/api/events', events);

  // 11. OpenAPI specification endpoint
  // Serve from the pre-generated openapi.json at dev time; in production
  // the file is bundled by wrangler. Run `npm run docs:openapi` to regenerate.
  let openApiSpec: Record<string, unknown> | null = null;
  app.get('/api/openapi.json', async (c) => {
    if (!openApiSpec) {
      try {
        const mod = await import('../../openapi.json' as string) as { default: Record<string, unknown> };
        openApiSpec = mod.default;
      } catch {
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
  const featureDeps: FeatureDeps = { stores, providers, eventBus, eventLoop, audit, permissionChecker: permService as any, ...(secretEncryption ? { secretEncryption } : {}) };
  // Mount each feature with and without trailing slash (Hono app.route() doesn't normalize)
  for (const feat of getFeatures()) {
    const router = feat.mount(featureDeps);
    app.route(feat.path, router);
    if (feat.path !== '/') {
      app.route(feat.path + '/', router);
    }
  }

  // 12. Log stream WebSocket — real-time container logs via DO
  const logStreamNs = platformBindings?.['LOG_STREAM_DO'] as DurableObjectNamespace | undefined;
  if (logStreamNs) {
    app.get('/api/sandboxes/:id/logs', async (c) => {
      const id = createSandboxId(c.req.param('id'));

      // Permission check: user needs 'read' on this sandbox
      const user = (c as any).var?.currentUser as { id: string } | undefined;
      if (permService && user) {
        const result = await permService.check({ userId: user.id, action: 'read', resource: 'sandbox' });
        if (!result.allowed) return c.json(fail('FORBIDDEN', result.reason), 403);
      }

      const entry = await stores.atomic.get<Sandbox>('sandbox:' + id);
      if (!entry) return c.json(fail('SANDBOX_NOT_FOUND', 'Sandbox not found'), 404);
      const sandbox = entry.value;
      if (!sandbox.providerId) return c.json(fail('NO_PROVIDER', 'Sandbox has no provider resource'), 400);

      // Resolve provider endpoint and platform from the ComputeInstance config
      const instanceId = sandbox.config.instanceId;
      let endpoint = 'http://127.0.0.1:8080/v1.24';
      let provider = 'podman';
      if (instanceId) {
        const instEntry = await stores.atomic.get<ComputeInstance>('instance:' + instanceId);
        if (instEntry) {
          endpoint = instEntry.value.endpoint;
          provider = instEntry.value.platform;
        }
      }

      // Forward WebSocket to the DO with standard log API params
      const tail = c.req.query('tail') ?? '';
      const since = c.req.query('since') ?? '';
      const stub = logStreamNs.get(logStreamNs.idFromName('logstream:' + id));
      const qs = new URLSearchParams({ providerId: sandbox.providerId, endpoint, provider });
      if (tail) qs.set('tail', tail);
      if (since) qs.set('since', since);
      const doUrl = `/logs?${qs.toString()}`;
      return stub.fetch(new URL(doUrl, 'https://do/'), c.req.raw);
    });
  }

  // 13. Export
  return {
    app,
    stores,
    providers,
    eventBus,
    eventLoop,
    dispose: async () => {
      eventLoop.stop();
    },
    seed: () => seedIfNeeded(stores.atomic),
  };
}

export const SYSTEM_FACILITY = createFacility('system');
