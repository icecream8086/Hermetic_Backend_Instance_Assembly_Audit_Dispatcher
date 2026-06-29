import { z } from 'zod';
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { IProviderRegistry } from '../../core/provider/interfaces.ts';
import { AppError } from '../../core/types.ts';
import type { AppContext } from '../../core/deps.ts';
import { ok } from '../../core/response.ts';

function requireRoot<E extends { Variables: { currentUser?: { role?: string } } }>(c: Context<E>): void {
  const user = c.var?.currentUser;
  if (!user || !['root', 'Operator', 'wheel'].includes(user.role)) {
    throw new AppError(403, 'FORBIDDEN', 'Admin access required');
  }
}

export function createImagesRouter(providers: IProviderRegistry): OpenAPIHono<{ Variables: AppContext }> {
  const app = new OpenAPIHono<{ Variables: AppContext }>();

  app.openapi(
    createRoute({ method: 'get', path: '/', tags: ['images'], summary: '列出镜像', responses: { 200: { description: 'ImageInfo[]', content: { 'application/json': { schema: z.any() } } } } }),
    async (c) => {
      const search = c.req.query('search');
      const limit = parseInt(c.req.query('limit') ?? '') || undefined;
      const offset = parseInt(c.req.query('offset') ?? '') || undefined;
      const instanceId = c.req.query('instanceId');
      const provider = instanceId ? await providers.resolveImage(instanceId as any) : providers.image;
      const images = await provider.list({ search, limit, offset } as any);
      return c.json(ok(images));
    },
  );

  app.openapi(
    createRoute({ method: 'post', path: '/pull', tags: ['images'], summary: '拉取镜像', responses: { 201: { description: 'ImageInfo', content: { 'application/json': { schema: z.any() } } } } }),
    async (c) => {
      requireRoot(c);
      const { image, instanceId, clusterId, credentialRef } = await c.req.json();
      if (!image) throw new AppError(400, 'VALIDATION_ERROR', 'image is required');
      const provider = instanceId ? await providers.resolveImage(instanceId) : providers.image;
      const info = await provider.pull(image, clusterId ?? credentialRef);
      return c.json(ok(info), 201);
    },
  );

  app.openapi(
    createRoute({ method: 'get', path: '/{id}', tags: ['images'], summary: '查看镜像详情', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'ImageInfo', content: { 'application/json': { schema: z.any() } } } } }),
    async (c) => {
      const id = c.req.param('id');
      const instanceId = c.req.query('instanceId');
      const provider = instanceId ? await providers.resolveImage(instanceId as any) : providers.image;
      const info = await provider.inspect(id);
      if (!info) throw new AppError(404, 'NOT_FOUND', 'Image not found');
      return c.json(ok(info));
    },
  );

  app.openapi(
    createRoute({ method: 'delete', path: '/{id}', tags: ['images'], summary: '删除镜像', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: z.any() } } } } }),
    async (c) => {
      requireRoot(c);
      const id = c.req.param('id');
      const instanceId = c.req.query('instanceId');
      const provider = instanceId ? await providers.resolveImage(instanceId as any) : providers.image;
      await provider.remove(id);
      return c.json(ok(null));
    },
  );

  app.openapi(
    createRoute({ method: 'post', path: '/{id}/tag', tags: ['images'], summary: '给镜像打标签', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'OK', content: { 'application/json': { schema: z.any() } } } } }),
    async (c) => {
      requireRoot(c);
      const id = c.req.param('id');
      const instanceId = c.req.query('instanceId');
      const { tag } = await c.req.json();
      if (!tag) throw new AppError(400, 'VALIDATION_ERROR', 'tag is required');
      const provider = instanceId ? await providers.resolveImage(instanceId as any) : providers.image;
      if (!provider.tag) throw new AppError(501, 'NOT_IMPLEMENTED', 'tag is not supported by the current provider');
      await provider.tag(id, tag);
      return c.json(ok(null));
    },
  );

  app.openapi(
    createRoute({ method: 'get', path: '/search', tags: ['images'], summary: '搜索远程镜像仓库', responses: { 200: { description: 'Search results', content: { 'application/json': { schema: z.any() } } } } }),
    async (c) => {
      const term = c.req.query('term');
      if (!term) throw new AppError(400, 'VALIDATION_ERROR', 'term is required');
      const instanceId = c.req.query('instanceId');
      const provider = instanceId ? await providers.resolveImage(instanceId as any) : providers.image;
      if (!provider.search) throw new AppError(501, 'NOT_IMPLEMENTED', 'search is not supported by the current provider');
      const results = await provider.search(term);
      return c.json(ok(results));
    },
  );

  app.openapi(
    createRoute({ method: 'post', path: '/prune', tags: ['images'], summary: '清理未使用的镜像', responses: { 200: { description: 'Result', content: { 'application/json': { schema: z.any() } } } } }),
    async (c) => {
      requireRoot(c);
      const instanceId = c.req.query('instanceId');
      const provider = instanceId ? await providers.resolveImage(instanceId as any) : providers.image;
      if (!provider.prune) throw new AppError(501, 'NOT_IMPLEMENTED', 'prune is not supported by the current provider');
      const { dangling } = await c.req.json();
      const result = await provider.prune({ dangling });
      return c.json(ok(result));
    },
  );

  app.openapi(
    createRoute({ method: 'get', path: '/{id}/history', tags: ['images'], summary: '查看镜像分层历史', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'History', content: { 'application/json': { schema: z.any() } } } } }),
    async (c) => {
      const id = c.req.param('id');
      const instanceId = c.req.query('instanceId');
      const provider = instanceId ? await providers.resolveImage(instanceId as any) : providers.image;
      if (!provider.history) throw new AppError(501, 'NOT_IMPLEMENTED', 'history is not supported by the current provider');
      const history = await provider.history(id);
      return c.json(ok(history));
    },
  );

  app.openapi(
    createRoute({ method: 'post', path: '/build', tags: ['images'], summary: '构建镜像', responses: { 201: { description: 'ImageInfo', content: { 'application/json': { schema: z.any() } } } } }),
    async (c) => {
      requireRoot(c);
      const instanceId = c.req.query('instanceId');
      const provider = instanceId ? await providers.resolveImage(instanceId as any) : providers.image;
      if (!provider.build) throw new AppError(501, 'NOT_IMPLEMENTED', 'build is not supported by the current provider');
      const { context, dockerfile, tag } = await c.req.json();
      const result = await provider.build(context, { dockerfile, tag });
      return c.json(ok(result), 201);
    },
  );

  return app;
}
