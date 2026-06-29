import { z } from 'zod';
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { AppError } from '../../core/types.ts';
import type { AppContext } from '../../core/deps.ts';
import type { IVolumeService } from './service.ts';
import { CreateVolumeSchema, UpdateVolumeSchema } from './schema.ts';
import type { CreateVolumeInput, UpdateVolumeInput } from './types.ts';
import { ok } from '../../core/response.ts';

function isRoot<E extends { Variables: { currentUser?: { role?: string } } }>(c: Context<E>): void {
  const user = c.var?.currentUser;
  if (!user || !['root', 'Operator', 'wheel'].includes(user.role)) {
    throw new AppError(403, 'FORBIDDEN', 'Admin access required');
  }
}

export function createVolumeRouter(svc: IVolumeService): OpenAPIHono<{ Variables: AppContext }> {
  const app = new OpenAPIHono<{ Variables: AppContext }>();

  app.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['volumes'],
      summary: '创建数据卷',
      request: { body: { content: { 'application/json': { schema: CreateVolumeSchema } } } },
      responses: { 201: { description: 'Volume created', content: { 'application/json': { schema: z.any() } } } },
    }),
    async (c) => {
      isRoot(c);
      const body = CreateVolumeSchema.parse(await c.req.json());
      const volume = await svc.create(body as CreateVolumeInput);
      return c.json(ok(volume), 201);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['volumes'],
      summary: '列出数据卷',
      responses: { 200: { description: 'Volume[]', content: { 'application/json': { schema: z.any() } } } },
    }),
    async (c) => {
      const page = parseInt(c.req.query('page') ?? '') || 1;
      const limit = parseInt(c.req.query('limit') ?? '') || 50;
      const filters: Record<string, string> = {};
      const n = c.req.query('name'); if (n) filters.name = n;
      const t = c.req.query('type'); if (t) filters.type = t;
      const s = c.req.query('status'); if (s) filters.status = s;
      const inst = c.req.query('instanceId'); if (inst) filters.instanceId = inst;
      return c.json(ok(await svc.listPaginated(page, limit, Object.keys(filters).length ? filters : undefined)));
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/{id}',
      tags: ['volumes'],
      summary: '获取数据卷详情',
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: { description: 'Volume', content: { 'application/json': { schema: z.any() } } } },
    }),
    async (c) => {
      const vol = await svc.get(c.req.param('id'));
      if (!vol) throw new AppError(404, 'VOLUME_NOT_FOUND', 'Volume not found');
      return c.json(ok(vol));
    },
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/{id}',
      tags: ['volumes'],
      summary: '更新数据卷配置',
      request: {
        params: z.object({ id: z.string() }),
        body: { content: { 'application/json': { schema: UpdateVolumeSchema } } },
      },
      responses: { 200: { description: 'Volume updated', content: { 'application/json': { schema: z.any() } } } },
    }),
    async (c) => {
      isRoot(c);
      const body = UpdateVolumeSchema.parse(await c.req.json());
      return c.json(ok(await svc.update(c.req.param('id'), body as UpdateVolumeInput)));
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/{id}',
      tags: ['volumes'],
      summary: '删除数据卷',
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: z.any() } } } },
    }),
    async (c) => {
      isRoot(c);
      await svc.delete(c.req.param('id'));
      return c.json(ok(null));
    },
  );

  return app;
}
