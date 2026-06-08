import { Hono } from 'hono';
import type { ISandboxService } from './interfaces.ts';
import type { PodResolver } from './assembly/pod-resolver.ts';
import { createSandboxId } from './types.ts';
import type { PodSpec } from './assembly/types.ts';
import type { IContainerGroupProvider } from '../../core/provider/interfaces.ts';
import type { RouteMeta } from '../../core/http-docs/types.ts';
import type { AppContext } from '../../core/app.ts';
import { ok, fail } from '../../core/response.ts';

type PermissionCheckFn = { check(params: { userId: string; action: string; resource: string; ip?: string }): Promise<{ allowed: boolean; reason: string }> };

async function requirePerm(c: any, checker: PermissionCheckFn | undefined, action: string, resource: string, resourceOwnerId?: string): Promise<Response | null> {
  if (!checker) return null;
  const user = (c as any).var?.currentUser;
  if (!user) return null;
  const result = await checker.check({ userId: user.id, action, resource, ...(resourceOwnerId ? { resourceOwnerId } : {}) });
  if (!result.allowed) return c.json(fail('FORBIDDEN', result.reason), 403);
  return null;
}

export function createSandboxRouter(
  svc: ISandboxService,
  podResolver?: PodResolver,
  permissionChecker?: PermissionCheckFn,
  podGroupProvider?: IContainerGroupProvider,
): Hono<{ Variables: AppContext }> {
  const router = new Hono<{ Variables: AppContext }>();

  // ─── Container group (Pod) API (static routes before parameterized :id) ───

  // POST /pod — create a pod from PodSpec
  router.post('/pod', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'create', 'sandbox'); if (r) return r; }
    if (!podResolver) {
      return c.json(fail('NOT_CONFIGURED', 'Container group provider not available'), 501);
    }
    try {
      const spec = await c.req.json<PodSpec>();
      if (!spec.name || !spec.services) {
        return c.json(fail('VALIDATION_ERROR', 'PodSpec requires name and services'), 400);
      }
      const result = await podResolver.apply(spec);
      return c.json(ok({ providerId: result.providerId, podName: spec.name }), 201);
    } catch (e: any) {
      return c.json(fail('POD_CREATE_FAILED', e.message), 500);
    }
  });

  // GET /pod — list all pods
  router.get('/pod', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'read', 'sandbox'); if (r) return r; }
    if (!podGroupProvider) {
      return c.json(fail('NOT_CONFIGURED', 'Container group provider not available'), 501);
    }
    try {
      const result = await podGroupProvider.describeGroups({ region: 'local' as any });
      return c.json(ok(result));
    } catch (e: any) {
      return c.json(fail('POD_LIST_FAILED', e.message), 500);
    }
  });

  // GET /pod/:providerId — get a single pod's status
  router.get('/pod/:providerId', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'read', 'sandbox'); if (r) return r; }
    if (!podGroupProvider) {
      return c.json(fail('NOT_CONFIGURED', 'Container group provider not available'), 501);
    }
    try {
      const providerId = c.req.param('providerId');
      const status = await podGroupProvider.getGroupStatus(providerId);
      if (!status) return c.json(fail('POD_NOT_FOUND', 'Pod not found'), 404);
      return c.json(ok(status));
    } catch (e: any) {
      return c.json(fail('POD_GET_FAILED', e.message), 500);
    }
  });

  // POST /pod/:providerId/stop — stop a pod (ECI: terminal, Podman: reversible)
  router.post('/pod/:providerId/stop', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'update', 'sandbox'); if (r) return r; }
    if (!podGroupProvider) {
      return c.json(fail('NOT_CONFIGURED', 'Container group provider not available'), 501);
    }
    try {
      const providerId = c.req.param('providerId');
      await podGroupProvider.stopGroup(providerId);
      return c.json(ok(null));
    } catch (e: any) {
      return c.json(fail('POD_STOP_FAILED', e.message), 500);
    }
  });

  // DELETE /pod/:providerId — delete a pod (terminal)
  router.delete('/pod/:providerId', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'delete', 'sandbox'); if (r) return r; }
    if (!podGroupProvider) {
      return c.json(fail('NOT_CONFIGURED', 'Container group provider not available'), 501);
    }
    try {
      const providerId = c.req.param('providerId');
      await podGroupProvider.deleteGroup(providerId);
      return c.json(ok(null));
    } catch (e: any) {
      return c.json(fail('POD_DELETE_FAILED', e.message), 500);
    }
  });

  // GET / — list all sandboxes (paginated)
  router.get('/', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'read', 'sandbox'); if (r) return r; }
    const status = c.req.query('status') as any || undefined;
    const limit = parseInt(c.req.query('limit') ?? '50');
    const cursor = c.req.query('cursor');
    const result = await svc.list?.(status, limit, cursor) ?? { items: [] };
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
      return c.json(fail('STOP_FAILED', e.message), 409);
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
      return c.json(fail('START_FAILED', e.message), 409);
    }
  });

  // DELETE /:id — terminate and delete a sandbox
  router.delete('/:id', async (c) => {
    const id = createSandboxId(c.req.param('id'));
    const sandbox = await svc.getById(id);
    const ownerId = sandbox?.config?.creatorId;
    const actorId = (c as any).var?.currentUser?.id;
    { const r = await requirePerm(c, permissionChecker, 'delete', 'sandbox', ownerId); if (r) return r; }
    try {
      await svc.terminate(id, actorId);
      return c.json(ok(null));
    } catch (e: any) {
      return c.json(fail('DELETE_FAILED', e.message), 404);
    }
  });

  // POST /:id/sync — sync runtime status from provider
  router.post('/:id/sync', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'update', 'sandbox'); if (r) return r; }
    const id = createSandboxId(c.req.param('id'));
    try {
      const runtime = await svc.syncRuntime(id);
      return c.json(ok(runtime));
    } catch (e: any) {
      return c.json(fail('SYNC_FAILED', e.message), 404);
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
  { method: 'GET', path: '/:id/logs', description: '实时容器日志流（WebSocket）— 升级为 WebSocket 后持续推送 stdout/stderr。支持标准日志参数: tail=N（最近 N 行后再 follow）, since=ts（UNIX 时间戳后的日志）, follow=1（持续推送，默认）。Podman 走 HTTP streaming，ECI 走 2s 轮询。容器停止时推 {"event":"container_stopped"}，删除时推 {"event":"container_deleted"} 后关闭连接。', responseDescription: 'WebSocket stream — 日志行文本 / JSON 事件' },
];
