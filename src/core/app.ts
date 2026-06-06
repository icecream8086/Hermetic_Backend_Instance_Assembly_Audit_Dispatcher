import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
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
import type { EventLoopConfig, TriggerEventInput } from './event-bus/types.ts';
import type { IAuditWriter, IAuditReader } from './audit/types.ts';
import type { Sandbox } from '../features/sandbox/types.ts';
import { SandboxStatus } from '../features/sandbox/types.ts';
import { WorkersAuditLogger, KvAuditLogger, createAuditRouter } from './audit/index.ts';
import { LocalAuditLogger } from './audit/local-audit-logger.ts';
import { NoopAuditLogger } from './audit/noop-audit-logger.ts';
import { authz } from './middleware/auth.ts';
import { jsonDepthLimit } from './middleware/security.ts';
import { setActivePolicy } from './logger/log-policy.ts';
import { PermissionService } from '../features/permission/service.ts';
import { ConsoleLogger } from './logger/console-logger.ts';
import { DoBridge } from './event-bus/do-bridge.ts';
import { createWsRouter } from './ws/router.ts';

export interface AppContext {
  stores: Stores;
  providers: IProviderRegistry;
  eventBus: EventBus;
  eventLoop: EventLoop;
  audit: IAuditWriter;
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
}

export interface AppInstance {
  app: Hono<{ Variables: AppContext }>;
  stores: Stores;
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

  // 2. Create provider registry (backed by ComputeInstance entities)
  const providers = createProviderRegistry(config.provider, config.s3, stores.atomic);

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
          const maxRetries = entry.value.config.healthMaxRetries ?? 11;
          if (maxRetries === -1) continue;
          const runtime = await providers.container.getStatus(entry.value.providerId ?? sid);
          if (!runtime) {
            // Provider 已无此容器 → 标记已清理
            for (let attempt = 0; attempt < 3; attempt++) {
              const latest = await stores.atomic.get<Sandbox>(`sandbox:${sid}`);
              if (!latest) break;
              const ver = await stores.atomic.set(`sandbox:${sid}`, { ...latest.value, status: SandboxStatus.Deleted, updatedAt: Date.now() }, latest.version);
              if (ver) break;
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
                if (ver) break;
              }
            }
          }
        } catch (e) { console.error(`[health] check error ${sid}:`, e instanceof Error ? e.message : e); }
      }
    } finally {
      // 重新入队，保证每 tick 执行一次
      eventLoop.enqueueTrigger({ type: 'health:check', payload: {} });
    }
  });
  // 触发首次健康检查
  eventLoop.enqueueTrigger({ type: 'health:check', payload: {} });

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
        const credSvc = new CredentialService(stores.atomic);
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
        const shardIdx = Math.abs(Array.from(id).reduce((h, c) => ((h << 5) + h) + c.charCodeAt(0), 5381)) % 4;
        const sk = 'sysgroup:idx:' + shardIdx;
        const idx = await stores.atomic.get<string[]>(sk);
        await stores.atomic.set(sk, [...(idx?.value ?? []), id], idx?.version ?? null);
        const cEntry = await stores.atomic.get<number>('sysgroup:count');
        await stores.atomic.set('sysgroup:count', (cEntry?.value ?? 0) + 1, cEntry?.version ?? null);
        count++;
      }

      // User groups (Linux convention: wheel for sudo, root/daemon/users for roles)
      const userGroupDefs = [
        { name: 'wheel', desc: 'Full sudo-level access' },
        { name: 'root', desc: 'System administrators' },
        { name: 'daemon', desc: 'Service accounts (key-only auth)' },
        { name: 'users', desc: 'Regular users (password auth)' },
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
        { userGroupName: 'daemon', sysGroupName: 'perm.operator' },
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

      // Owner permission group: resource owners can manage their own resources.
      // Rules with `:$self` match when the acting user === resourceOwnerId.
      {
        const usersUgId = userGroupIds['users'];
        if (usersUgId) {
          const pgId = `permgrp_${crypto.randomUUID()}`;
          await stores.atomic.set('permgroup:' + pgId, {
            id: pgId, name: 'perm.owner',
            rules: [
              { effect: 'allow', actions: ['create', 'read', 'update', 'delete'], resource: 'sandbox:$self', priority: 90 },
              { effect: 'allow', actions: ['create', 'read', 'update', 'delete'], resource: 'template:$self', priority: 90 },
            ],
            userGroupIds: [usersUgId], userIds: [], dependsOn: [],
            createdAt: now, updatedAt: now,
          }, null);
          const pgIdx = await stores.atomic.get<string[]>('permgroup:ids');
          await stores.atomic.set('permgroup:ids', [...(pgIdx?.value ?? []), pgId], pgIdx?.version ?? null);
          count++;
        }
      }

      // Route ACLs: per-group access model
      //   wheel — full access (`* /`)
      //   root  — containers, templates, audit logs, users list
      //   users — create/update own containers, users list
      //   daemon — users list (service accounts)
      type RouteAclDef = { method: string; pathPrefix: string; priority: number };
      const groupAcls: Record<string, RouteAclDef[]> = {
        wheel: [{ method: '*', pathPrefix: '/', priority: 1000 }],
        root: [
          { method: '*', pathPrefix: '/api/networks', priority: 100 },
          { method: '*', pathPrefix: '/api/sandboxes', priority: 100 },
          { method: '*', pathPrefix: '/api/templates', priority: 100 },
          { method: '*', pathPrefix: '/api/topology', priority: 100 },
          { method: 'GET', pathPrefix: '/api/audit', priority: 100 },
          { method: 'GET', pathPrefix: '/api/platforms', priority: 100 },
          { method: 'GET', pathPrefix: '/api/users', priority: 10 },
          { method: 'PUT', pathPrefix: '/api/users', priority: 10 },
          { method: 'DELETE', pathPrefix: '/api/users', priority: 10 },
        ],
        users: [
          { method: 'GET', pathPrefix: '/api/networks', priority: 50 },
          { method: 'GET', pathPrefix: '/api/templates', priority: 50 },
          { method: 'POST', pathPrefix: '/api/templates', priority: 50 },
          { method: 'GET', pathPrefix: '/api/sandboxes', priority: 50 },
          { method: 'POST', pathPrefix: '/api/sandboxes', priority: 50 },
          { method: 'PUT', pathPrefix: '/api/sandboxes', priority: 50 },
          { method: 'GET', pathPrefix: '/api/platforms', priority: 50 },
          { method: 'GET', pathPrefix: '/api/users', priority: 10 },
          { method: 'PUT', pathPrefix: '/api/users', priority: 10 },
          { method: 'DELETE', pathPrefix: '/api/users', priority: 10 },
          { method: 'GET', pathPrefix: '/api/topology', priority: 50 },
          { method: 'POST', pathPrefix: '/api/topology', priority: 50 },
          { method: 'PUT', pathPrefix: '/api/topology', priority: 50 },
          { method: 'DELETE', pathPrefix: '/api/topology', priority: 50 },
        ],
        daemon: [
          { method: 'GET', pathPrefix: '/api/users', priority: 10 },
        ],
      };
      for (const [grpName, acls] of Object.entries(groupAcls)) {
        const grpId = userGroupIds[grpName];
        if (!grpId) continue;
        for (const def of acls) {
          const aclId = `routeacl_${crypto.randomUUID()}`;
          await stores.atomic.set('routeacl:' + aclId, {
            id: aclId, method: def.method, pathPrefix: def.pathPrefix,
            matchType: 'prefix', effect: 'allow', userGroupId: grpId,
            priority: def.priority, createdAt: now, updatedAt: now,
          }, null);
          const raIdx = await stores.atomic.get<string[]>('routeacl:ids');
          await stores.atomic.set('routeacl:ids', [...(raIdx?.value ?? []), aclId], raIdx?.version ?? null);
          count++;
        }
      }

      await stores.atomic.set(KEY, { seededAt: now }, null);
      // MAC rules — immutable system policies, never modifiable via API.
// These protect critical resources against accidental or malicious deletion.
// MAC rules are loaded at startup and enforced in checkPermission() before all other rules.
{ const mk = '_init:mac-policy'; const me = await stores.atomic.get<any>(mk);
  if (me === null) {
    await stores.atomic.set(mk, { rules: [
      // ── Critical identity protection ──
      { effect: 'deny', actions: ['delete'], resource: 'user:root', priority: 9999, description: 'Cannot delete the root user — would break system ownership' },
      { effect: 'deny', actions: ['admin'], resource: 'user:root', priority: 9999, description: 'Cannot change the root user role — root must remain root' },

      // ── Core group protection ──
      { effect: 'deny', actions: ['delete', 'admin'], resource: 'usergroup:wheel', priority: 9999, description: 'Cannot delete or modify wheel group — would break privilege model' },
      { effect: 'deny', actions: ['delete', 'admin'], resource: 'usergroup:daemon', priority: 9999, description: 'Cannot delete or modify daemon group — service accounts would be orphaned' },
      { effect: 'deny', actions: ['delete'], resource: 'usergroup:root', priority: 9999, description: 'Cannot delete the root user group' },
      { effect: 'deny', actions: ['delete'], resource: 'usergroup:users', priority: 9999, description: 'Cannot delete the default users group' },

      // ── System group protection ──
      { effect: 'deny', actions: ['admin', 'delete', 'create', 'update'], resource: 'sysgroup', priority: 9999, description: 'Cannot create, modify or delete system groups — immutable policy templates' },
      { effect: 'deny', actions: ['delete'], resource: 'permgroup', priority: 9999, description: 'Cannot delete seed permission groups (perm.sysadmin/operator/viewer/auth)' },

      // ── Seed data integrity ──
      { effect: 'deny', actions: ['admin', 'delete', 'update'], resource: '_init:', priority: 9999, description: 'Cannot modify or delete any _init:* keys — seed data is immutable' },
      { effect: 'deny', actions: ['delete'], resource: '_sys:initialized', priority: 9999, description: 'Cannot delete the initialization flag — would allow re-setup' },
      { effect: 'deny', actions: ['admin', 'update'], resource: '_sys:initialized', priority: 9999, description: 'Cannot set _sys:initialized back to false' },

      // ── MAC policy self-protection ──
      { effect: 'deny', actions: ['delete', 'admin', 'update'], resource: '_init:mac-policy', priority: 9999, description: 'Cannot modify or delete MAC policy itself — systemic integrity' },

      // ── Route ACL integrity ──
      { effect: 'deny', actions: ['delete'], resource: 'routeacl:ids', priority: 9999, description: 'Cannot delete the route ACL index — would bypass all access control' },

      // ── Template integrity — specific seed templates only ──
      // (Generic template delete is governed by requirePerm + requireRoot)

      // ── Permission group binding integrity ──
      { effect: 'deny', actions: ['admin'], resource: 'permgroup', priority: 9998, description: 'Admin actions cannot bypass permission group evaluation' },
    ]}, null); count++; }
}
console.log(`[${new Date().toISOString()}] INFO: [init] Policy library seeded: ${count} items (${sysGroups.length} system groups, ${userGroupDefs.length} user groups + route ACLs)`);
    }
  }

  // 6ab. Seed default ComputeInstance (merged cluster + instance)
  let defaultInstanceId: string | undefined;
  {
    const KEY = '_init:default-instance';
    const entry = await stores.atomic.get<any>(KEY);
    if (entry === null) {
      try {
        const instanceSvc = new (await import('../core/region/instance.ts')).InstanceService(stores.atomic);
        const podmanEp = process.env['PODMAN_ENDPOINT'] ?? 'http://127.0.0.1:8080';
        const instance = await instanceSvc.create({
          name: 'default-podman',
          platform: 'podman',
          region: 'local',
          zone: 'local-a',
          endpoint: podmanEp,
          labels: { networkDomain: 'podman-default' },
          capabilities: { container: true, image: true, group: true, network: true, s3: true, metrics: false, dns: false },
        });
        defaultInstanceId = instance.id as string;
        await stores.atomic.set(KEY, { instanceId: defaultInstanceId, seededAt: Date.now() }, null);
        console.log(`[${new Date().toISOString()}] INFO: [init] Default instance seeded: ${defaultInstanceId}`);
      } catch (e: unknown) {
        console.error(`[${new Date().toISOString()}] ERROR: [init] Failed to seed default instance: ${e instanceof Error ? e.message : e}`);
      }
    } else {
      defaultInstanceId = entry.value.instanceId;
    }
  }

  // 6b. Seed built-in sandbox templates with DAG inheritance demo
  {
    const KEY = '_init:sandbox-tpls';
    const entry = await stores.atomic.get<any>(KEY);
    if (entry === null) {
      const now = Date.now();
      const ids: Record<string, string> = {};
      const cid = defaultInstanceId;

      // ── Layer 0: base templates ──
      const baseAlpineId = `tpl_${crypto.randomUUID()}`; ids.base_alpine = baseAlpineId;
      const nginxId = `tpl_${crypto.randomUUID()}`; ids.nginx = nginxId;
      const fedoraId = `tpl_${crypto.randomUUID()}`; ids.fedora = fedoraId;
      const minioId = `tpl_${crypto.randomUUID()}`; ids.minio = minioId;

      // ── Layer 1: inherits from base-alpine ──
      const customAlpineId = `tpl_${crypto.randomUUID()}`; ids.custom_alpine = customAlpineId;

      // ── Layer 2: inherits from custom-alpine + nginx ──
      const fullStackId = `tpl_${crypto.randomUUID()}`; ids.full_stack = fullStackId;

      // ── 验证模板: nginx-arg — 展示 command/args 从种子模板穿透到容器的完整链路 ──
      // Apply 后 `podman inspect <container>` 应看到:
      //   Path="nginx", Args=["-g", "daemon off;"]
      const nginxArgId = `tpl_${crypto.randomUUID()}`; ids.nginx_arg = nginxArgId;

      // ── v2 容器组模板: demo-pod — docker-compose 风格, 使用 PodResolver + IContainerGroupProvider ──
      // apiVersion: hbi-aad/v2, kind: ContainerGroup
      // Apply 后创建包含 nginx + alpine 的 Podman pod，共享网络命名空间
      const demoPodId = `tpl_${crypto.randomUUID()}`; ids.demo_pod = demoPodId;
      const gpuInferenceId = `tpl_${crypto.randomUUID()}`; ids.gpu_inference = gpuInferenceId;

      const tpls: any[] = [
        {
          id: baseAlpineId, name: 'base-alpine',
          description: 'Base Alpine Linux — minimal OS layer, 256MB RAM, sleep 3600',
          apiVersion: 'hbi-aad/v1', kind: 'Container',
          dependsOn: [],
          container: {
            region: 'local',
            instanceId: cid,
            containers: [{
              name: 'alpine', image: 'docker.io/library/alpine:latest',
              command: ['sleep', '3600'],
              resources: { limits: { cpu: 0.25, memory: 256 } },
            }],
            restartPolicy: 'Never',
          },
          network: { publicIp: { allocate: false } },
          createdAt: now, updatedAt: now,
        },
        {
          id: nginxId, name: 'nginx',
          description: 'Nginx web server — ports 80, readiness check',
          apiVersion: 'hbi-aad/v1', kind: 'Container',
          dependsOn: [],
          singleton: true,
          container: {
            region: 'local',
            instanceId: cid,
            containers: [{
              name: 'nginx', image: 'docker.io/library/nginx:latest',
              command: ['nginx'],
              args: ['-g', 'daemon off;'],
              ports: [{ containerPort: 80, protocol: 'TCP' }],
              resources: { limits: { cpu: 0.5, memory: 128 } },
            }],
            restartPolicy: 'Always',
          },
          healthChecks: [{
            name: 'nginx-alive',
            target: 'container:nginx',
            type: 'liveness',
            probe: { httpGet: { path: '/', port: 80 } },
            periodSeconds: 10,
            initialDelaySeconds: 5,
          }, {
            name: 'nginx-ready',
            target: 'container:nginx',
            type: 'readiness',
            probe: { tcpSocket: { port: 80 } },
            periodSeconds: 5,
            initialDelaySeconds: 2,
          }],
          network: { publicIp: { allocate: false } },
          createdAt: now, updatedAt: now,
        },
        {
          id: fedoraId, name: 'fedora',
          description: 'Fedora Linux — minimal OS layer, 256MB RAM, sleep 3600',
          apiVersion: 'hbi-aad/v1', kind: 'Container',
          dependsOn: [],
          container: {
            region: 'local',
            instanceId: cid,
            containers: [{
              name: 'fedora', image: 'registry.fedoraproject.org/fedora:latest',
              command: ['sleep', '3600'],
              resources: { limits: { cpu: 0.25, memory: 256 } },
            }],
            restartPolicy: 'Never',
          },
          healthChecks: [{
            name: 'fedora-alive',
            target: 'container:fedora',
            type: 'liveness',
            probe: { exec: { command: ['sh', '-c', 'kill -0 1'] } },
            periodSeconds: 15,
            initialDelaySeconds: 5,
            failureThreshold: 3,
          }],
          network: { publicIp: { allocate: false } },
          createdAt: now, updatedAt: now,
        },
        // gpu-inference — GPU 推理工作负载示例
        // 需要宿主机有 NVIDIA GPU + nvidia-container-toolkit
        // WSL 下不可用，但可正常创建模板和沙箱（GPU 字段存在但 Stub 不绑定）
        {
          id: gpuInferenceId, name: 'gpu-inference',
          description: 'GPU inference server — requires NVIDIA GPU (nvidia.com/gpu)',
          apiVersion: 'hbi-aad/v1', kind: 'Container',
          dependsOn: [],
          container: {
            region: 'local',
            instanceId: cid,
            containers: [{
              name: 'inference', image: 'nvidia/cuda:12.2-runtime',
              command: ['python', '-m', 'my_inference_server'],
              resources: { limits: { cpu: 4, memory: 8192, gpu: 1 } },
              ports: [{ containerPort: 8080, protocol: 'TCP' }],
            }],
            restartPolicy: 'Always',
          },
          network: { publicIp: { allocate: true } },
          createdAt: now, updatedAt: now,
        },
        {
          id: minioId, name: 'minio-server',
          description: 'MinIO S3-compatible object storage — ports 9000 (API) / 9001 (console)',
          apiVersion: 'hbi-aad/v1', kind: 'Container',
          dependsOn: [],
          singleton: true,
          container: {
            region: 'local',
            instanceId: cid,
            containers: [{
              name: 'minio', image: 'quay.io/minio/minio:latest',
              command: ['server', '/data', '--console-address', ':9001'],
              ports: [
                { containerPort: 9000, protocol: 'TCP' },
                { containerPort: 9001, protocol: 'TCP' },
              ],
              env: [
                { name: 'MINIO_ROOT_USER', value: 'minioadmin' },
                { name: 'MINIO_ROOT_PASSWORD', value: 'minioadmin' },
              ],
              resources: { limits: { cpu: 0.5, memory: 512 } },
            }],
            restartPolicy: 'Always',
          },
          healthChecks: [{
            name: 'minio-ready',
            target: 'container:minio',
            type: 'readiness',
            probe: { tcpSocket: { port: 9000 } },
            periodSeconds: 5,
            initialDelaySeconds: 5,
          }],
          network: { publicIp: { allocate: true } },
          createdAt: now, updatedAt: now,
        },
        // DAG chain: base-alpine → custom-alpine
        {
          id: customAlpineId, name: 'custom-alpine',
          description: 'Custom Alpine — inherits base-alpine, adds curl + env vars',
          apiVersion: 'hbi-aad/v1', kind: 'Container',
          dependsOn: [baseAlpineId],
          container: {
            region: 'local',
            instanceId: cid,
            containers: [{
              name: 'alpine',
              command: ['sh', '-c', 'while true; do echo "Hello from DAG"; curl -s http://localhost/health 2>/dev/null || echo "nginx not ready"; sleep 10; done'],
              env: [
                { name: 'APP_ENV', value: 'development' },
                { name: 'LOG_LEVEL', value: 'debug' },
              ],
            }],
            restartPolicy: 'Never',
          },
          createdAt: now, updatedAt: now,
        },
        // DAG merge: (base-alpine→custom-alpine) + nginx = full-stack
        {
          id: fullStackId, name: 'full-stack',
          description: 'Full stack — merges custom-alpine + nginx with app container',
          apiVersion: 'hbi-aad/v1', kind: 'Container',
          dependsOn: [customAlpineId, nginxId],
          container: {
            region: 'local',
            instanceId: cid,
            containers: [{
              name: 'alpine',
              env: [
                { name: 'NGINX_HOST', value: 'localhost' },
                { name: 'DB_URL', value: 'sqlite:///data/app.db' },
              ],
            }],
          },
          network: { publicIp: { allocate: true } },
          createdAt: now, updatedAt: now,
        },
        // nginx-arg — 验证 command/args 穿透链路；和 nginx 模板功能一致，仅作为参数传递的参考
        {
          id: nginxArgId, name: 'nginx-arg',
          description: 'Nginx with explicit command+args — 验证模板参数穿透到容器',
          apiVersion: 'hbi-aad/v1', kind: 'Container',
          dependsOn: [],
          singleton: true,
          container: {
            region: 'local',
            instanceId: cid,
            containers: [{
              name: 'nginx-arg', image: 'docker.io/library/nginx:latest',
              command: ['nginx'],
              args: ['-g', 'daemon off;'],
              ports: [{ containerPort: 80, protocol: 'TCP' }],
              resources: { limits: { cpu: 0.5, memory: 128 } },
            }],
            restartPolicy: 'Always',
          },
          healthChecks: [{
            name: 'nginx-arg-alive',
            target: 'container:nginx-arg',
            type: 'liveness',
            probe: { httpGet: { path: '/', port: 80 } },
            periodSeconds: 10,
            initialDelaySeconds: 5,
          }],
          network: { publicIp: { allocate: false } },
          createdAt: now, updatedAt: now,
        },
        // demo-pod — v2 容器组模板 (hbi-aad/v2, kind=ContainerGroup)
        // 使用 PodResolver 解析，创建 Podman pod，共享 net/uts/ipc
        // 验证: podman pod inspect <name> 看 Containers 字段
        {
          id: demoPodId, name: 'demo-pod',
          description: 'v2 容器组 — nginx + alpine 共享网络 (docker-compose 风格)',
          apiVersion: 'hbi-aad/v2', kind: 'ContainerGroup',
          dependsOn: [],
          podSpec: {
            name: 'demo-pod',
            region: 'local',
            resources: { cpu: '1.0', memory: '512Mi' },
            services: {
              web: {
                image: 'docker.io/library/nginx:latest',
                command: ['nginx', '-g', 'daemon off;'],
                ports: [{ containerPort: 80, protocol: 'TCP' }],
                resources: { cpu: '0.5', memory: '128Mi' },
              },
              sidecar: {
                image: 'docker.io/library/alpine:latest',
                command: ['sh', '-c', 'while true; do echo "sidecar alive"; sleep 30; done'],
                dependsOn: ['web'],
                resources: { cpu: '0.25', memory: '64Mi' },
              },
            },
          },
          createdAt: now, updatedAt: now,
        },
      ];

      // Write all templates + index
      const allIds = [baseAlpineId, nginxId, nginxArgId, customAlpineId, fullStackId, fedoraId, minioId, demoPodId, gpuInferenceId];
      for (const t of tpls) {
        await stores.atomic.set('sandbox-tpl:' + t.id, t, null);
      }
      await stores.atomic.set('sandbox-tpl:ids', allIds, null);
      await stores.atomic.set(KEY, { seededAt: now }, null);
      console.log(`[${new Date().toISOString()}] INFO: [init] Sandbox templates seeded: ${tpls.length} (${tpls.map(t => t.name).join(', ')})`);
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
  app.use('*', bodyLimit({ maxSize: 5 * 1024 * 1024 }));  // 5 MB
  app.use('*', jsonDepthLimit(10));                   // max JSON nesting
  app.use('*', rateLimit({ windowMs: 60_000, maxRequests: 100 }));
  app.onError(globalErrorHandler);

  // 8. Inject context variables
  app.use('*', async (c, next) => {
    c.set('stores', stores);
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
  const featureDeps: FeatureDeps = { stores, providers, eventBus, eventLoop, audit, permissionChecker: permService as any };
  // Mount each feature with and without trailing slash (Hono app.route() doesn't normalize)
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
    providers,
    eventBus,
    eventLoop,
    dispose: async () => {
      eventLoop.stop();
    },
  };
}

export const SYSTEM_FACILITY = createFacility('system');
