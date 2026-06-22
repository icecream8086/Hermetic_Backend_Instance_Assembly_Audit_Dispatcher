import { Hono } from 'hono';
import type { IProviderRegistry } from '../../core/provider/interfaces.ts';
import type { AppContext } from '../../core/deps.ts';
import { ok, fail } from '../../core/response.ts';
import type { RouteMeta } from '../../core/http-docs/types.ts';

function requireRoot(c: any): Response | null {
  const user = c.var?.currentUser;
  if (!user) return null;
  const isRoot = user.role === 'root' || user.role === 'Operator' || user.role === 'wheel';
  if (!isRoot) return c.json(fail('FORBIDDEN', 'Admin access required'), 403);
  return null;
}

export function createImagesRouter(providers: IProviderRegistry): Hono<{ Variables: AppContext }> {
  const router = new Hono<{ Variables: AppContext }>();

  // ─── List images ───

  router.get('/', async (c) => {
    const search = c.req.query('search');
    const limit = parseInt(c.req.query('limit') ?? '') || undefined;
    const offset = parseInt(c.req.query('offset') ?? '') || undefined;
    const instanceId = c.req.query('instanceId');

    const provider = instanceId
      ? await providers.resolveImage(instanceId as any)
      : providers.image;

    const images = await provider.list({ search, limit, offset } as any);
    return c.json(ok(images));
  });

  // ─── Pull image ───

  router.post('/pull', async (c) => {
    const r = requireRoot(c); if (r) return r;
    const { image, instanceId, clusterId, credentialRef } = await c.req.json() as any;
    if (!image) return c.json(fail('VALIDATION_ERROR', 'image is required'), 400);

    const provider = instanceId
      ? await providers.resolveImage(instanceId as any)
      : providers.image;

    const info = await provider.pull(image, clusterId ?? credentialRef);
    return c.json(ok(info), 201);
  });

  // ─── Inspect image ───

  router.get('/:id', async (c) => {
    const id = c.req.param('id');
    const instanceId = c.req.query('instanceId');

    const provider = instanceId
      ? await providers.resolveImage(instanceId as any)
      : providers.image;

    const info = await provider.inspect(id);
    if (!info) return c.json(fail('NOT_FOUND', 'Image not found'), 404);
    return c.json(ok(info));
  });

  // ─── Remove image ───

  router.delete('/:id', async (c) => {
    const r = requireRoot(c); if (r) return r;
    const id = c.req.param('id');
    const instanceId = c.req.query('instanceId');

    const provider = instanceId
      ? await providers.resolveImage(instanceId as any)
      : providers.image;

    await provider.remove(id);
    return c.json(ok(null));
  });

  // ─── Tag image ───

  router.post('/:id/tag', async (c) => {
    const r = requireRoot(c); if (r) return r;
    const id = c.req.param('id');
    const instanceId = c.req.query('instanceId');
    const { tag } = await c.req.json() as any;
    if (!tag) return c.json(fail('VALIDATION_ERROR', 'tag is required'), 400);

    const provider = instanceId ? await providers.resolveImage(instanceId as any) : providers.image;
    if (!provider.tag) return c.json(fail('NOT_IMPLEMENTED', 'tag is not supported by the current provider'), 501);
    await provider.tag(id, tag);
    return c.json(ok(null));
  });

  // ─── Search registries ───

  router.get('/search', async (c) => {
    const term = c.req.query('term');
    if (!term) return c.json(fail('VALIDATION_ERROR', 'term is required'), 400);
    const instanceId = c.req.query('instanceId');

    const provider = instanceId ? await providers.resolveImage(instanceId as any) : providers.image;
    if (!provider.search) return c.json(fail('NOT_IMPLEMENTED', 'search is not supported by the current provider'), 501);
    const results = await provider.search(term);
    return c.json(ok(results));
  });

  // ─── Prune images ───

  router.post('/prune', async (c) => {
    const r = requireRoot(c); if (r) return r;
    const instanceId = c.req.query('instanceId');
    const provider = instanceId ? await providers.resolveImage(instanceId as any) : providers.image;
    if (!provider.prune) return c.json(fail('NOT_IMPLEMENTED', 'prune is not supported by the current provider'), 501);
    const { dangling } = await c.req.json() as any;
    const result = await provider.prune({ dangling });
    return c.json(ok(result));
  });

  // ─── Image history ───

  router.get('/:id/history', async (c) => {
    const id = c.req.param('id');
    const instanceId = c.req.query('instanceId');
    const provider = instanceId ? await providers.resolveImage(instanceId as any) : providers.image;
    if (!provider.history) return c.json(fail('NOT_IMPLEMENTED', 'history is not supported by the current provider'), 501);
    const history = await provider.history(id);
    return c.json(ok(history));
  });

  // ─── Build image ───

  router.post('/build', async (c) => {
    const r = requireRoot(c); if (r) return r;
    const instanceId = c.req.query('instanceId');
    const provider = instanceId ? await providers.resolveImage(instanceId as any) : providers.image;
    if (!provider.build) return c.json(fail('NOT_IMPLEMENTED', 'build is not supported by the current provider'), 501);
    const { context, dockerfile, tag } = await c.req.json() as any;
    const result = await provider.build(context, { dockerfile, tag });
    return c.json(ok(result), 201);
  });

  return router;
}

export const imagesRouteMeta: RouteMeta[] = [
  { method: 'GET', path: '/', description: '列出镜像（?search=&limit=&offset=&instanceId=）', responseDescription: 'ImageInfo[]' },
  { method: 'POST', path: '/pull', description: '拉取镜像', requestBody: { image: 'nginx:latest', instanceId: 'inst_xxx' }, responseDescription: 'ImageInfo' },
  { method: 'GET', path: '/:id', description: '查看镜像详情（?instanceId=）', responseDescription: 'ImageInfo' },
  { method: 'DELETE', path: '/:id', description: '删除镜像', responseDescription: '{ ok: true }' },
  { method: 'POST', path: '/:id/tag', description: '给镜像打标签', requestBody: { tag: 'myrepo/myimage:v2' }, responseDescription: '{ ok: true }' },
  { method: 'GET', path: '/search', description: '搜索远程镜像仓库（?term=）', responseDescription: '{ name, description, isOfficial }[]' },
  { method: 'POST', path: '/prune', description: '清理未使用的镜像', requestBody: { dangling: true }, responseDescription: '{ reclaimed: number }' },
  { method: 'GET', path: '/:id/history', description: '查看镜像分层历史', responseDescription: '{ id, created, createdBy, size }[]' },
  { method: 'POST', path: '/build', description: '通过 Dockerfile 上下文构建镜像', requestBody: { dockerfile: 'FROM nginx', tag: 'custom-nginx' }, responseDescription: 'ImageInfo' },
];
