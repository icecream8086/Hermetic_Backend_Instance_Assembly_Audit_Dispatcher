import { Hono } from 'hono';
import type { RouteMeta } from '../../core/http-docs/types.ts';
import type { AppContext } from '../../core/app.ts';
import { ok, fail } from '../../core/response.ts';
import { KernLevel } from '../../core/audit/kern-level.ts';

type PermissionCheckFn = { check(params: { userId: string; action: string; resource: string; ip?: string }): Promise<{ allowed: boolean; reason: string }> };

async function requirePerm(c: any, checker: PermissionCheckFn | undefined, action: string, resource: string, resourceOwnerId?: string): Promise<Response | null> {
  if (!checker) return null;
  const user = (c as any).var?.currentUser;
  if (!user) return null;
  const result = await checker.check({ userId: user.id, action, resource, ...(resourceOwnerId ? { resourceOwnerId } : {}) });
  if (!result.allowed) return c.json(fail('FORBIDDEN', result.reason), 403);
  return null;
}

export function createImageRouter(permissionChecker?: PermissionCheckFn): Hono<{ Variables: AppContext }> {
  const router = new Hono<{ Variables: AppContext }>();

  router.get('/', async (c) => {
    try {
      const platform = c.req.query('platform');
      const page = parseInt(c.req.query('page') ?? '') || 1;
      const limit = parseInt(c.req.query('limit') ?? '') || 50;
      // Pass limit/offset hint to provider — providers that support server-side
      // pagination (e.g. Alibaba) can reduce data transfer. Those that don't
      // ignore the params and return everything; the handler slices below.
      const offset = (page - 1) * limit;
      let images = await c.var.providers.image.list({ limit, offset });
      if (platform) images = images.filter(i => i.architecture === platform);
      const total = images.length;
      const start = (page - 1) * limit;
      return c.json(ok({ items: images.slice(start, start + limit), total, page, limit }));
    } catch (e: any) {
      return c.json(fail('PROVIDER_ERROR', e.message), 502);
    }
  });

  router.post('/pull', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'create', 'image'); if (r) return r; }
    const { image, instanceId } = await c.req.json() as { image: string; instanceId?: string };
    if (!image) return c.json(fail('VALIDATION_ERROR', 'image required'), 400);
    try {
      // Resolve image provider, optionally per-cluster (multi-server Podman)
      const imgProvider = instanceId && c.var.providers.resolveImage
        ? await c.var.providers.resolveImage(instanceId as any)
        : c.var.providers.image;
      const info = await imgProvider.pull(image, instanceId);
      const user = (c as any).var?.currentUser as { id: string } | undefined;
      c.var.audit?.write({
        level: KernLevel.NOTICE,
        facility: 'image',
        message: `Image pulled — ${image}`,
        metadata: { eventType: 'image.pulled', image, actorId: user?.id },
      });
      return c.json(ok(info));
    } catch (e: any) {
      return c.json(fail('PULL_FAILED', e.message), 502);
    }
  });

  router.get('/:id', async (c) => {
    try {
      const info = await c.var.providers.image.inspect(c.req.param('id'));
      if (!info) return c.json(fail('IMAGE_NOT_FOUND', 'Image not found'), 404);
      return c.json(ok(info));
    } catch (e: any) {
      return c.json(fail('PROVIDER_ERROR', e.message), 502);
    }
  });

  router.delete('/:id', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'delete', 'image'); if (r) return r; }
    try {
      await c.var.providers.image.remove(c.req.param('id'));
      return c.json(ok(null));
    } catch (e: any) {
      return c.json(fail('PROVIDER_ERROR', e.message), 502);
    }
  });

  return router;
}

export const imageRouteMeta: RouteMeta[] = [
  { method: 'GET', path: '/', description: '列出所有镜像，支持 ?platform=linux/amd64 过滤', responseDescription: 'ImageInfo[]' },
  { method: 'POST', path: '/pull', description: '拉取镜像（支持所有 provider）', requestBody: { image: 'docker.io/library/nginx:latest' }, responseDescription: 'ImageInfo' },
  { method: 'GET', path: '/:id', description: '查看镜像详情', responseDescription: 'ImageInfo' },
  { method: 'DELETE', path: '/:id', description: '删除镜像', responseDescription: '{ ok: true }' },
];
