import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ISandboxService } from './interfaces.ts';
import { PodResolver } from './assembly/pod-resolver.ts';
import { createSandboxId } from './types.ts';
import type { PodSpec } from './assembly/types.ts';
import type { IContainerGroupProvider, IProviderRegistry } from '../../core/provider/interfaces.ts';
import type { RouteMeta } from '../../core/http-docs/types.ts';
import type { AppContext } from '../../core/deps.ts';
import { ok, fail } from '../../core/response.ts';

type PermissionCheckFn = { check(params: { userId: string; action: string; resource: string; ip?: string }): Promise<{ allowed: boolean; reason: string }> };

/** Extract HTTP status and error code from a caught error, respecting AppError subtypes. */
function errorStatus(e: unknown, fallbackCode: string, fallbackStatus = 500): { code: string; status: any } {
  const status: any = (e as any)?.statusCode ?? (e as any)?.status ?? fallbackStatus;
  const code = (e as any)?.code ?? fallbackCode;
  return { code, status };
}

type SandboxEnv = { Variables: AppContext };

async function requirePerm(c: Context<SandboxEnv>, checker: PermissionCheckFn | undefined, action: string, resource: string, resourceOwnerId?: string): Promise<Response | null> {
  if (!checker) return null;
  const user = c.var.currentUser;
  if (!user) return null;
  const result = await checker.check({ userId: user.id, action, resource, ...(resourceOwnerId ? { resourceOwnerId } : {}) });
  if (!result.allowed) return c.json(fail('FORBIDDEN', result.reason), 403);
  return null;
}

/** Resolve the right container group provider — never falls back to a global default. */
async function resolvePodProvider(providers: IProviderRegistry, _region?: string, instanceId?: string): Promise<IContainerGroupProvider | undefined> {
  return providers.resolveGroup(instanceId as any);
}

/** Find a v2 sandbox by providerId. Returns the sandbox or null. */
async function findV2ByProviderId(svc: ISandboxService, providerId: string): Promise<{ id: any } | null> {
  const all = await (svc.list?.(undefined, 1000) ?? Promise.resolve({ items: [] }));
  return all.items.find((s: any) => s.providerId === providerId && s.config?.apiVersion === 'hbi-aad/v2') ?? null;
}

export function createSandboxRouter(
  svc: ISandboxService,
  providers: IProviderRegistry,
  permissionChecker?: PermissionCheckFn,
): Hono<{ Variables: AppContext }> {
  const router = new Hono<{ Variables: AppContext }>();

  // ─── Container group (Pod) API (static routes before parameterized :id) ───

  // POST /pod — create a pod from PodSpec
  router.post('/pod', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'create', 'sandbox'); if (r) return r; }
    try {
      const spec = await c.req.json<PodSpec>();
      if (!spec.name || !spec.services) {
        return c.json(fail('VALIDATION_ERROR', 'PodSpec requires name and services'), 400);
      }
      // Resolve the right group provider for the target region/instance — no global default.
      const groupProvider = await resolvePodProvider(providers, spec.region, spec.instanceId as any);
      if (!groupProvider) {
        return c.json(fail('NOT_CONFIGURED', `No container group provider available for region=${spec.region ?? '(unspecified)'}. Register an instance with group capability or use a different region.`), 501);
      }
      const podResolver = new PodResolver(groupProvider);
      const result = await podResolver.apply(spec);
      return c.json(ok({ providerId: result.providerId, podName: spec.name }), 201);
    } catch (e: any) {
      return c.json(fail('POD_CREATE_FAILED', e.message), 500);
    }
  });

  // GET /pod — list all container groups (v2 sandboxes with apiVersion=hbi-aad/v2)
  // Falls back to sandbox list when no dedicated group provider is registered.
  router.get('/pod', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'read', 'sandbox'); if (r) return r; }
    try {
      const groupProvider = await resolvePodProvider(providers);
      if (groupProvider) {
        const result = await groupProvider.describeGroups({ region: 'local' as any });
        return c.json(ok(result));
      }
      // Fallback: v2 sandboxes managed through lifecycle
      const result = await svc.list?.(undefined, 100) ?? { items: [] };
      const v2Items = result.items.filter(s => (s.config as any).apiVersion === 'hbi-aad/v2');
      return c.json(ok({ items: v2Items }));
    } catch (e: any) {
      return c.json(fail('POD_LIST_FAILED', e.message), 500);
    }
  });

  // GET /pod/:providerId — get a single pod by providerId (v2 sandbox)
  router.get('/pod/:providerId', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'read', 'sandbox'); if (r) return r; }
    try {
      const groupProvider = await resolvePodProvider(providers);
      const providerId = c.req.param('providerId');
      if (groupProvider) {
        const status = await groupProvider.getGroupStatus(providerId);
        if (!status) return c.json(fail('POD_NOT_FOUND', 'Pod not found'), 404);
        return c.json(ok(status));
      }
      // Fallback: search v2 sandbox by providerId
      const all = await svc.list?.(undefined, 1000) ?? { items: [] };
      const match = all.items.find(s => s.providerId === providerId && (s.config as any).apiVersion === 'hbi-aad/v2');
      if (!match) return c.json(fail('POD_NOT_FOUND', 'Pod not found'), 404);
      return c.json(ok(match));
    } catch (e: any) {
      return c.json(fail('POD_GET_FAILED', e.message), 500);
    }
  });

  // POST /pod/:providerId/stop — stop a pod (ECI: terminal, Podman: reversible)
  router.post('/pod/:providerId/stop', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'update', 'sandbox'); if (r) return r; }
    try {
      const groupProvider = await resolvePodProvider(providers);
      const providerId = c.req.param('providerId');
      if (groupProvider) {
        await groupProvider.stopGroup(providerId);
        return c.json(ok(null));
      }
      // Fallback: stop v2 sandbox by providerId
      const sandbox = await findV2ByProviderId(svc, providerId);
      if (!sandbox) return c.json(fail('POD_NOT_FOUND', 'Pod not found'), 404);
      await svc.stop(sandbox.id);
      return c.json(ok(null));
    } catch (e: any) {
      return c.json(fail('POD_STOP_FAILED', e.message), 500);
    }
  });

  // DELETE /pod/:providerId — delete a pod (terminal)
  router.delete('/pod/:providerId', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'delete', 'sandbox'); if (r) return r; }
    try {
      const groupProvider = await resolvePodProvider(providers);
      const providerId = c.req.param('providerId');
      if (groupProvider) {
        await groupProvider.deleteGroup(providerId);
        return c.json(ok(null));
      }
      const sandbox = await findV2ByProviderId(svc, providerId);
      if (!sandbox) return c.json(fail('POD_NOT_FOUND', 'Pod not found'), 404);
      await svc.terminate(sandbox.id);
      return c.json(ok(null));
    } catch (e: any) {
      return c.json(fail('POD_DELETE_FAILED', e.message), 500);
    }
  });

  // POST /pod/:providerId/sync — sync pod status from provider
  router.post('/pod/:providerId/sync', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'update', 'sandbox'); if (r) return r; }
    try {
      const providerId = c.req.param('providerId');
      const sandbox = await findV2ByProviderId(svc, providerId);
      if (!sandbox) return c.json(fail('POD_NOT_FOUND', 'Pod not found'), 404);
      const runtime = await svc.syncRuntime(sandbox.id);
      return c.json(ok(runtime));
    } catch (e: any) {
      return c.json(fail('SYNC_FAILED', e.message), 502);
    }
  });

  // GET /pod/:providerId/health — container health status
  router.get('/pod/:providerId/health', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'read', 'sandbox'); if (r) return r; }
    try {
      const providerId = c.req.param('providerId');
      const sandbox = await findV2ByProviderId(svc, providerId);
      if (!sandbox) return c.json(fail('POD_NOT_FOUND', 'Pod not found'), 404);
      const health = await svc.getHealth(sandbox.id);
      return c.json(ok(health));
    } catch (e: any) {
      return c.json(fail('HEALTH_FAILED', e.message), 500);
    }
  });

  // POST /pod/:providerId/restart — restart a running pod
  router.post('/pod/:providerId/restart', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'update', 'sandbox'); if (r) return r; }
    try {
      const providerId = c.req.param('providerId');
      const sandbox = await findV2ByProviderId(svc, providerId);
      if (!sandbox) return c.json(fail('POD_NOT_FOUND', 'Pod not found'), 404);
      const result = await svc.restart(sandbox.id);
      return c.json(ok(result));
    } catch (e: any) {
      return c.json(fail('RESTART_FAILED', e.message), 409);
    }
  });

  // GET / — list all sandboxes (paginated)
  router.get('/', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'read', 'sandbox'); if (r) return r; }
    const status = c.req.query('status') as any || undefined;
    const apiVer = c.req.query('apiVersion');
    const limit = parseInt(c.req.query('limit') ?? '50');
    const cursor = c.req.query('cursor');
    let result = await svc.list?.(status, limit, cursor) ?? { items: [] };
    if (apiVer) {
      result = { ...result, items: result.items.filter(s => (s.config as any).apiVersion === apiVer) };
    } else {
      // Default: exclude v2 container groups (show v1 only)
      result = { ...result, items: result.items.filter(s => (s.config as any).apiVersion !== 'hbi-aad/v2') };
    }
    return c.json(ok(result));
  });

  // GET /:id — get a single sandbox
  router.get('/:id', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'read', 'sandbox'); if (r) return r; }
    const id = createSandboxId(c.req.param('id'));
    const sandbox = await svc.getById(id);
    if (!sandbox) return c.json(fail('SANDBOX_NOT_FOUND', 'Sandbox not found'), 404);
    return c.json(ok(sandbox));
  });

  // POST /:id/stop — stop a sandbox
  router.post('/:id/stop', async (c) => {
    const id = createSandboxId(c.req.param('id'));
    const sandbox = await svc.getById(id);
    const ownerId = sandbox?.config?.creatorId;
    { const r = await requirePerm(c, permissionChecker, 'update', 'sandbox', ownerId); if (r) return r; }
    try {
      const stopped = await svc.stop(id);
      return c.json(ok(stopped));
    } catch (e: any) {
      const { code, status } = errorStatus(e, 'STOP_FAILED', 409);
      return c.json(fail(code, e.message), status);
    }
  });

  // POST /:id/start — start a stopped sandbox
  router.post('/:id/start', async (c) => {
    const id = createSandboxId(c.req.param('id'));
    const sandbox = await svc.getById(id);
    const ownerId = sandbox?.config?.creatorId;
    { const r = await requirePerm(c, permissionChecker, 'update', 'sandbox', ownerId); if (r) return r; }
    try {
      if (!svc.start) return c.json(fail('START_FAILED', 'Start not supported by this service'), 501);
      const started = await svc.start(id);
      return c.json(ok(started));
    } catch (e: any) {
      const { code, status } = errorStatus(e, 'START_FAILED', 409);
      return c.json(fail(code, e.message), status);
    }
  });

  // DELETE /:id — terminate and delete a sandbox
  router.delete('/:id', async (c) => {
    const id = createSandboxId(c.req.param('id'));
    const sandbox = await svc.getById(id);
    const ownerId = sandbox?.config?.creatorId;
    const actorId = c.var.currentUser?.id;
    { const r = await requirePerm(c, permissionChecker, 'delete', 'sandbox', ownerId); if (r) return r; }
    try {
      await svc.terminate(id, actorId);
      return c.json(ok(null));
    } catch (e: any) {
      const { code, status } = errorStatus(e, 'DELETE_FAILED', 404);
      return c.json(fail(code, e.message), status);
    }
  });

  // POST /:id/sync — fire-and-forget async sync from provider
  router.post('/:id/sync', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'update', 'sandbox'); if (r) return r; }
    const id = createSandboxId(c.req.param('id'));
    try {
      const runtime = await svc.syncRuntime(id);
      const updated = await svc.getById(id);
      return c.json(ok({ runtime, sandbox: updated }), 200);
    } catch (e: any) {
      const { code, status } = errorStatus(e, 'SYNC_FAILED', 502);
      return c.json(fail(code, e.message), status);
    }
  });

  // GET /:id/health — container health status
  router.get('/:id/health', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'read', 'sandbox'); if (r) return r; }
    const id = createSandboxId(c.req.param('id'));
    try {
      const health = await svc.getHealth(id);
      return c.json(ok(health));
    } catch (e: any) {
      return c.json(fail('HEALTH_FAILED', e.message), e.status ?? 500);
    }
  });

  // POST /:id/restart — restart a running sandbox (ECI: RestartContainerGroup)
  router.post('/:id/restart', async (c) => {
    const id = createSandboxId(c.req.param('id'));
    const sandbox = await svc.getById(id);
    const ownerId = sandbox?.config?.creatorId;
    { const r = await requirePerm(c, permissionChecker, 'update', 'sandbox', ownerId); if (r) return r; }
    try {
      const result = await svc.restart(id);
      return c.json(ok(result));
    } catch (e: any) {
      const { code, status } = errorStatus(e, 'RESTART_FAILED', 409);
      return c.json(fail(code, e.message), status);
    }
  });

  // PATCH /:id — update a running sandbox's specification (ECI: UpdateContainerGroup)
  router.patch('/:id', async (c) => {
    const id = createSandboxId(c.req.param('id'));
    const sandbox = await svc.getById(id);
    const ownerId = sandbox?.config?.creatorId;
    { const r = await requirePerm(c, permissionChecker, 'update', 'sandbox', ownerId); if (r) return r; }
    try {
      const body = await c.req.json<Partial<import('./types.ts').CreateSandboxInput>>();
      const result = await svc.update(id, body);
      return c.json(ok(result));
    } catch (e: any) {
      const { code, status } = errorStatus(e, 'UPDATE_FAILED', 409);
      return c.json(fail(code, e.message), status);
    }
  });

  return router;
}

export const sandboxRouteMeta: RouteMeta[] = [
  { method: 'POST', path: '/pod', description: '从 PodSpec 创建容器组（Pod），返回 providerId', requestBody: { name: 'my-pod', services: { nginx: { image: 'nginx:latest' } } }, responseDescription: '{ providerId, podName }' },
  { method: 'GET', path: '/pod', description: '列出所有容器组（Pod）— 通过 IContainerGroupProvider.describeGroups', responseDescription: 'DescribeContainerGroupsResult' },
  { method: 'GET', path: '/pod/:providerId', description: '获取容器组（Pod）详情', responseDescription: 'ContainerGroupRuntime' },
  { method: 'POST', path: '/pod/:providerId/stop', description: '停止容器组（Pod）— ECI 停止即释放(terminal), Podman 可逆', responseDescription: '{ ok: true }' },
  { method: 'DELETE', path: '/pod/:providerId', description: '删除容器组（Pod）— 终态操作', responseDescription: '{ ok: true }' },
  { method: 'GET', path: '/', description: '列出所有沙箱（支持 ?status=&limit=&cursor= 过滤）', responseDescription: '{ items: Sandbox[], nextCursor }' },
  { method: 'GET', path: '/:id', description: '获取沙箱详情（含网络/容器/事件）', responseDescription: 'Sandbox' },
  { method: 'POST', path: '/:id/stop', description: '停止沙箱', responseDescription: 'Sandbox' },
  { method: 'POST', path: '/:id/start', description: '启动已停止的沙箱', responseDescription: 'Sandbox' },
  { method: 'DELETE', path: '/:id', description: '终止并删除沙箱', responseDescription: '{ ok: true }' },
  { method: 'POST', path: '/:id/sync', description: '从 provider 同步最新运行状态', responseDescription: 'ContainerGroupRuntime' },
  { method: 'GET', path: '/:id/health', description: '获取容器健康状态', responseDescription: 'ContainerHealth[]' },
  { method: 'POST', path: '/:id/restart', description: '重启运行中的沙箱（ECI: RestartContainerGroup）', responseDescription: 'Sandbox' },
  { method: 'PATCH', path: '/:id', description: '更新运行中沙箱的规格（ECI: UpdateContainerGroup）', requestBody: { resourceSpec: { cpu: 2, memory: 4096 } }, responseDescription: 'Sandbox' },
  { method: 'GET', path: '/:id/logs', description: '实时容器日志流（WebSocket）— 升级为 WebSocket 后持续推送 stdout/stderr。支持标准日志参数: tail=N（最近 N 行后再 follow）, since=ts（UNIX 时间戳后的日志）, follow=1（持续推送，默认）。Podman 走 HTTP streaming，ECI 走 2s 轮询。容器停止时推 {"event":"container_stopped"}，删除时推 {"event":"container_deleted"} 后关闭连接。', responseDescription: 'WebSocket stream — 日志行文本 / JSON 事件' },
];
