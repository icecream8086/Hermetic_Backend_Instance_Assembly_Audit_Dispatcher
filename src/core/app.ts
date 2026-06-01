import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
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
import { createTimerBackend } from './scheduler/factory.ts';
import { EventBus } from './event-bus/bus.ts';
import { EventLoop } from './event-bus/loop.ts';
import type { EventLoopConfig, TriggerEventInput } from './event-bus/types.ts';
import type { IAuditWriter, IAuditReader } from './audit/types.ts';
import type { Sandbox } from '../features/sandbox/types.ts';
import { SandboxStatus } from '../features/sandbox/types.ts';
import { WorkersAuditLogger, createAuditRouter } from './audit/index.ts';
import { authz } from './middleware/auth.ts';
import { jsonDepthLimit } from './middleware/security.ts';
import { setActivePolicy } from './logger/log-policy.ts';
import { PermissionService } from '../features/permission/service.ts';
import { ConsoleLogger } from './logger/console-logger.ts';

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
  /** Optional action+resource level permission checker (PermissionService.check compatible). */
  permissionChecker?: { check(params: { userId: string; action: string; resource: string; ip?: string }): Promise<{ allowed: boolean; reason: string }> };
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

/**
 * Assemble the application: wire stores, logger, providers, event system, middleware, and routes.
 */
export async function createApp(config: AppConfig, platformBindings?: Record<string, unknown>): Promise<AppInstance> {
  // 1. Create storage adapters (KV, file, etc.)
  const stores = createStores(config.storage, platformBindings);

  // 1b. 审计日志: console → Workers Logs (纯转发，不本地缓存)
  const auditLogger = new WorkersAuditLogger();
  const audit: IAuditWriter = auditLogger;
  const auditReader: IAuditReader = auditLogger;

  // 2. Create logger infrastructure
  const logRouter = new LogRouter();

  // 3. Create container provider implementations
  const providers = createProviderRegistry(config.provider, config.s3);

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
      intervalMs: 5000,
      batchSize: config.scheduler.batchSize,
      autoStart: true,
    } as Partial<EventLoopConfig>,
    schedulerBackend,
    stores.atomic,
  );

  // 5b. 健康检查事件：每 tick 查询 provider 实时状态，可配重试次数，-1 为白名单
  eventBus.on('health:check', async () => {
    const idx = await stores.atomic.get<string[]>('sandbox:ids');
    if (!idx || !providers.container.getStatus) return;
    for (const sid of idx.value) {
      try {
        const entry = await stores.atomic.get<Sandbox>(`sandbox:${sid}`);
        // 检查所有非 Deleted 的沙箱（Running / Stopped / Terminated 都需要确认容器已清理）
        if (!entry || entry.value.status === SandboxStatus.Deleted) continue;
        const maxRetries = entry.value.config.healthMaxRetries ?? 10;
        if (maxRetries === -1) continue;
        // 从 provider 获取实时状态
        // provider 返回 null 表示容器已不存在，标记已清理
        const runtime = await providers.container.getStatus(entry.value.providerId ?? sid);
        if (!runtime) {
          console.error(`[health] runtime null for ${sid}, deleting`);
          for (let attempt = 0; attempt < 3; attempt++) {
            const latest = await stores.atomic.get<Sandbox>(`sandbox:${sid}`);
            if (!latest) break;
            const ver = await stores.atomic.set(`sandbox:${sid}`, { ...latest.value, status: SandboxStatus.Deleted, updatedAt: Date.now() }, latest.version);
            if (ver) { console.error(`[health] deleted ${sid}`); break; }
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
          console.log(`[${new Date().toISOString()}] NOTICE: [health] sandbox ${sid} unhealthy (${fails}/${maxRetries})`);
          if (fails >= maxRetries) {
            console.log(`[${new Date().toISOString()}] NOTICE: [health] terminating sandbox ${sid} (${fails} consecutive)`);
            await providers.container.delete({ region: entry.value.config.region, providerId: entry.value.providerId ?? sid });
            // OCC 重试最多 3 次
            for (let attempt = 0; attempt < 3; attempt++) {
              const latest = await stores.atomic.get<Sandbox>(`sandbox:${sid}`);
              if (!latest) break;
              const ver = await stores.atomic.set(`sandbox:${sid}`, { ...latest.value, status: SandboxStatus.Deleted, updatedAt: Date.now() }, latest.version);
              if (ver) break;
            }
          }
        }
      } catch (e) { console.error(`[health] check error ${sid}:`, e instanceof Error ? e.message : e); }
    }
  });
  // 注册连续健康检查事件（每 tick 触发一次）
  eventLoop.enqueueTrigger({ type: 'health:check', payload: {} });

  // 5c. Load log policy into runtime (non-blocking)
  stores.atomic.get<any>('_sys:log-policy').then(entry => {
    if (entry) setActivePolicy(entry.value);
  }).catch(() => {});

  // 6. Initialize policy library (first-run seeding — Linux/RBAC-style)
  {
    const KEY = '_init:policy-lib';
    const entry = await stores.atomic.get<any>(KEY);
    if (entry === null) {
      const now = Date.now();
      let count = 0;

      // System groups (global, no user binding, evaluated first)
      const sysGroups = [
        { name: 'perm.sysadmin', desc: 'Full system access', rules: [{ effect: 'allow', actions: ['*'], resource: '*', priority: 100 }] },
        { name: 'perm.operator', desc: 'Operational CRUD', rules: [{ effect: 'allow', actions: ['create', 'read', 'update', 'delete'], priority: 80 }, { effect: 'deny', actions: ['admin'], priority: 90 }] },
        { name: 'perm.viewer', desc: 'Read-only', rules: [{ effect: 'allow', actions: ['read'], priority: 70 }] },
        { name: 'perm.auth', desc: 'Authentication only', rules: [{ effect: 'allow', actions: ['login'], resource: 'session', priority: 60 }, { effect: 'deny', actions: ['*'], resource: '*', priority: 50 }] },
      ];
      const sysGroupIds: Record<string, string> = {};
      for (const g of sysGroups) {
        const id = `sysgrp_${crypto.randomUUID()}`;
        sysGroupIds[g.name] = id;
        await stores.atomic.set('sysgroup:' + id, { id, name: g.name, description: g.desc, rules: g.rules, priority: g.rules[0]!.priority, dependsOn: [], createdAt: now, updatedAt: now }, null);
        const idx = await stores.atomic.get<string[]>('sysgroup:ids');
        await stores.atomic.set('sysgroup:ids', [...(idx?.value ?? []), id], idx?.version ?? null);
        count++;
      }

      // User groups (Linux convention: wheel for sudo, root/daemon/users for roles)
      const userGroupDefs = [
        { name: 'wheel', desc: 'Full sudo-level access' },
        { name: 'root', desc: 'System administrators' },
        { name: 'daemon', desc: 'Service accounts' },
        { name: 'users', desc: 'Regular users' },
      ];
      const userGroupIds: Record<string, string> = {};
      for (const g of userGroupDefs) {
        const id = `usergrp_${crypto.randomUUID()}`;
        userGroupIds[g.name] = id;
        await stores.atomic.set('usergroup:' + id, { id, name: g.name, description: g.desc, memberIds: [], dependsOn: [], createdAt: now, updatedAt: now }, null);
        const ugIdx = await stores.atomic.get<string[]>('usergroup:ids');
        await stores.atomic.set('usergroup:ids', [...(ugIdx?.value ?? []), id], ugIdx?.version ?? null);
        count++;
      }

      // Link user groups → system group rules via permission groups.
      // This makes checkPermission() evaluate sysadmin/operator/viewer rules
      // for members of wheel/root/users respectively.
      const permGroupBindings: Array<{ userGroupName: string; sysGroupName: string }> = [
        { userGroupName: 'wheel', sysGroupName: 'perm.sysadmin' },
        { userGroupName: 'root', sysGroupName: 'perm.operator' },
        { userGroupName: 'users', sysGroupName: 'perm.viewer' },
      ];
      for (const b of permGroupBindings) {
        const sgEntry = await stores.atomic.get<any>('sysgroup:' + sysGroupIds[b.sysGroupName]);
        if (!sgEntry) continue;
        const ugId = userGroupIds[b.userGroupName];
        if (!ugId) continue;
        const pgId = `permgrp_${crypto.randomUUID()}`;
        await stores.atomic.set('permgroup:' + pgId, {
          id: pgId, name: b.sysGroupName,
          rules: sgEntry.value.rules, userGroupIds: [ugId],
          userIds: [], dependsOn: [],
          createdAt: now, updatedAt: now,
        }, null);
        const pgIdx = await stores.atomic.get<string[]>('permgroup:ids');
        await stores.atomic.set('permgroup:ids', [...(pgIdx?.value ?? []), pgId], pgIdx?.version ?? null);
        count++;
      }

      // Default Route ACLs for groups (Linux-style: users = basic, wheel = full)
      for (const [grpName, grpId] of Object.entries(userGroupIds)) {
        const isWheel = grpName === 'wheel';
        const aclId = `routeacl_${crypto.randomUUID()}`;
        await stores.atomic.set('routeacl:' + aclId, {
          id: aclId, method: isWheel ? '*' : 'GET', pathPrefix: isWheel ? '/' : '/api/users',
          matchType: 'prefix', effect: 'allow', userGroupId: grpId,
          priority: isWheel ? 1000 : 10, createdAt: now, updatedAt: now,
        }, null);
        const raIdx = await stores.atomic.get<string[]>('routeacl:ids');
        await stores.atomic.set('routeacl:ids', [...(raIdx?.value ?? []), aclId], raIdx?.version ?? null);
        count++;
      }

      await stores.atomic.set(KEY, { seededAt: now }, null);
      console.log(`[${new Date().toISOString()}] INFO: [init] Policy library seeded: ${count} items (${sysGroups.length} system groups, ${userGroupDefs.length} user groups + route ACLs)`);
    }
  }

  // 6b. Seed built-in sandbox templates (Nginx demo)
  {
    const KEY = '_init:sandbox-tpls';
    const entry = await stores.atomic.get<any>(KEY);
    if (entry === null) {
      const now = Date.now();
      const tpls = [
        {
          id: `tpl_${crypto.randomUUID()}`,
          name: 'nginx',
          description: 'Nginx web server demo — lightweight, ports 80',
          spec: {
            provider: 'podman',
            region: 'local',
            containers: [{
              name: 'nginx', image: 'docker.io/library/nginx:latest',
              ports: [{ containerPort: 80, protocol: 'TCP' }],
              resources: { limits: { cpu: 0.5, memory: 128 } },
              readinessProbe: { tcpSocket: { port: 80 }, periodSeconds: 5, initialDelaySeconds: 2 },
            }],
            network: { allocatePublicIp: false },
            restartPolicy: 'Always',
          },
          createdAt: now, updatedAt: now,
        },
      ];
      for (const t of tpls) {
        await stores.atomic.set('sandbox-tpl:' + t.id, t, null);
        const idx = await stores.atomic.get<string[]>('sandbox-tpl:ids');
        await stores.atomic.set('sandbox-tpl:ids', [...(idx?.value ?? []), t.id], idx?.version ?? null);
      }
      await stores.atomic.set(KEY, { seededAt: now }, null);
      console.log(`[${new Date().toISOString()}] INFO: [init] Sandbox templates seeded: ${tpls.length} (nginx)`);
    }
  }

  // 7. Build Hono app
  const app = new Hono<{ Variables: AppContext }>();

  // 7. Apply global middleware (timing first = outermost, wrapping everything)
  app.use('*', async (c, next) => {
    const t0 = performance.now();
    await next();
    c.header('Server-Timing', `total;dur=${(performance.now() - t0).toFixed(2)}`);
  });
  app.use('*', secureHeaders());
  app.use('*', cors());
  app.use('*', bodyLimit({ maxSize: 100 * 1024 }));  // 100 KB
  app.use('*', jsonDepthLimit(10));                   // max JSON nesting
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

  // 9. Dev-only: localhost → add user to the seed 'wheel' group (bypasses auth)
  // NOTE: This adds to wheel group ONLY. Does NOT elevate role to 'root'.
  // The permission engine's checkRouteAccess requires DUAL verification:
  //   wheel group membership AND role === 'root' (Linux sudo model).
  // Role must come from first-user auto-promotion or be set by an existing root.
  app.post('/__become-wheel', async (c) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('cf-connecting-ip');
    if (ip && ip !== '127.0.0.1' && ip !== '::1' && !ip.startsWith('::ffff:127.')) {
      return c.json({ success: false, error: 'Only available from localhost' }, 403);
    }
    const atomic = c.var.stores.atomic;
    const { userId } = await c.req.json<{ userId: string }>();
    if (!userId) return c.json({ success: false, error: 'userId required' }, 400);

    // Find the seed 'wheel' group
    const ugEntry = await atomic.get<string[]>('usergroup:ids');
    let wheelGroupId: string | null = null;
    if (ugEntry) {
      for (const id of ugEntry.value) {
        const g = await atomic.get<any>('usergroup:' + id);
        if (g?.value?.name === 'wheel') { wheelGroupId = id; break; }
      }
    }

    if (!wheelGroupId) {
      return c.json({ success: false, error: 'wheel group not found — seed data may not have been initialized' }, 500);
    }

    const now = Date.now();
    const gEntry = await atomic.get<any>('usergroup:' + wheelGroupId);
    if (!gEntry) {
      return c.json({ success: false, error: 'wheel group not found in store' }, 500);
    }

    // Add user to wheel group if not already a member
    if (!gEntry.value.memberIds.includes(userId)) {
      gEntry.value.memberIds.push(userId);
      gEntry.value.updatedAt = now;
      await atomic.set('usergroup:' + wheelGroupId, gEntry.value, gEntry.version);
    }

    // Ensure user-level route ACL exists
    const raEntry = await atomic.get<string[]>('routeacl:ids');
    if (raEntry) {
      const hasUserAcl = raEntry.value.some(async (id) => {
        const a = await atomic.get<any>('routeacl:' + id);
        return a?.value?.userId === userId;
      });
      if (!hasUserAcl) {
        const aclId = `routeacl_${crypto.randomUUID()}`;
        await atomic.set('routeacl:' + aclId, { id: aclId, method: '*', pathPrefix: '/api', matchType: 'prefix', effect: 'allow', userId, priority: 999, createdAt: now, updatedAt: now }, null);
        await atomic.set('routeacl:ids', [...raEntry.value, aclId], raEntry.version);
      }
    }

    console.log(`[${new Date().toISOString()}] INFO: [become-wheel] userId=${userId} added to wheel group`);
    return c.json({ success: true, data: { message: 'Added to wheel group — user now has elevated privileges' } });
  });

  // 10. Auth + route ACL middleware
  let permService: PermissionService | undefined;
  if (config.authz?.enabled !== false) {
    permService = new PermissionService(stores.atomic, new ConsoleLogger(), audit);
    app.use('/api/*', authz({
      store: stores.atomic,
      audit,
      checkRouteAccess: async (method, path, userId) => {
        return permService!.checkRouteAccess(method, path, userId);
      },
      publicPaths: [
        '/api/users/register',
        '/api/users/login',
        '/api/users/login-info',
        '/api/users/no-password-login',
        '/api/openapi.json',
      ],
    }));
  }

  // 11. DO alarm callback route
  app.post('/__tick', async (c) => {
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

  // 12. Auto-register features from generated registry
  // Mount at both /path and /path/ since Hono's route() doesn't normalize
  // trailing slashes — /api/users matches but /api/users/ does not.
  const featureDeps: FeatureDeps = { stores, logRouter, providers, eventBus, eventLoop, audit, permissionChecker: permService as any };
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
