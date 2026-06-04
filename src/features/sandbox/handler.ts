import { Hono } from 'hono';
import type { ISandboxService } from './interfaces.ts';
import type { PodResolver } from './assembly/pod-resolver.ts';
import { createSandboxId } from './types.ts';
import type { PodSpec } from './assembly/types.ts';
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
): Hono<{ Variables: AppContext }> {
  const router = new Hono<{ Variables: AppContext }>();

  // ─── Container group (Pod) API (static route before parameterized :id) ───

  router.post('/pod', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'create', 'sandbox'); if (r) return r; }
    if (!podResolver) {
      return c.json(fail('NOT_CONFIGURED', 'Container group provider not available — no IContainerGroupProvider registered'), 501);
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
  { method: 'GET', path: '/', description: '列出所有沙箱（支持 ?status=&limit=&cursor= 过滤）', responseDescription: '{ items: Sandbox[], nextCursor }' },
  { method: 'GET', path: '/:id', description: '获取沙箱详情（含网络/容器/事件）', responseDescription: 'Sandbox' },
  { method: 'POST', path: '/:id/stop', description: '停止沙箱', responseDescription: 'Sandbox' },
  { method: 'DELETE', path: '/:id', description: '终止并删除沙箱', responseDescription: '{ ok: true }' },
  { method: 'POST', path: '/:id/sync', description: '从 provider 同步最新运行状态', responseDescription: 'ContainerGroupRuntime' },
  { method: 'GET', path: '/:id/health', description: '获取容器健康状态', responseDescription: 'ContainerHealth[]' },
];
