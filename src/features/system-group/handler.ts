import { z } from 'zod';
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { ISysGroupService } from './service.ts';
import { AppError } from '../../core/types.ts';
import type { AppContext } from '../../core/deps.ts';
import { CreateSysGroupSchema, UpdateSysGroupSchema } from './schema.ts';
import { ok } from '../../core/response.ts';
import { OkResponse, ErrorResponse, PaginatedResponse } from '../../core/http-docs/response-schema.ts';
import { SysGroupSchema } from './response-schema.ts';

function requireRoot<E extends { Variables: { currentUser?: { role?: string } } }>(c: Context<E>): void {
  const user = c.var.currentUser;
  if (!user || !['root', 'Operator', 'wheel'].includes(user.role)) {
    throw new AppError(403, 'FORBIDDEN', 'Admin access required');
  }
}

export function createSysGroupRouter(svc: ISysGroupService): OpenAPIHono<{ Variables: AppContext }> {
  const app = new OpenAPIHono<{ Variables: AppContext }>();

  app.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['system-groups'],
      summary: '创建系统权限组',
      request: { body: { content: { 'application/json': { schema: CreateSysGroupSchema } } } },
      responses: { 201: { description: 'SysGroup created', content: { 'application/json': { schema: OkResponse(SysGroupSchema) } } }, 400: { description: 'Bad request', content: { 'application/json': { schema: ErrorResponse } } }, 403: { description: 'Forbidden', content: { 'application/json': { schema: ErrorResponse } } }, 500: { description: 'Internal error', content: { 'application/json': { schema: ErrorResponse } } } },
    }),
    async (c) => {
      requireRoot(c);
      const body = await CreateSysGroupSchema.parse(c.req.json());
      const group = await svc.create(body, c.var.currentUser?.id);
      return c.json(ok(group), 201);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['system-groups'],
      summary: '列出所有系统权限组',
      responses: { 200: { description: 'SysGroup[]', content: { 'application/json': { schema: PaginatedResponse(SysGroupSchema) } } }, 403: { description: 'Forbidden', content: { 'application/json': { schema: ErrorResponse } } }, 500: { description: 'Internal error', content: { 'application/json': { schema: ErrorResponse } } } },
    }),
    async (c) => {
      requireRoot(c);
      const page = parseInt(c.req.query('page') ?? '') || 1;
      const limit = parseInt(c.req.query('limit') ?? '') || 50;
      const name = c.req.query('name');
      const { items, total } = await svc.listPaginated(page, limit, name);
      return c.json(ok({ items, total, page, limit }), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/{id}',
      tags: ['system-groups'],
      summary: '获取系统权限组详情',
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: { description: 'SysGroup', content: { 'application/json': { schema: OkResponse(SysGroupSchema) } } }, 403: { description: 'Forbidden', content: { 'application/json': { schema: ErrorResponse } } }, 404: { description: 'Not found', content: { 'application/json': { schema: ErrorResponse } } }, 500: { description: 'Internal error', content: { 'application/json': { schema: ErrorResponse } } } },
    }),
    async (c) => {
      requireRoot(c);
      const group = await svc.get(c.req.param('id'));
      if (!group) throw new AppError(404, 'SYSGROUP_NOT_FOUND', 'System group not found');
      return c.json(ok(group), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/{id}',
      tags: ['system-groups'],
      summary: '更新系统权限组',
      request: {
        params: z.object({ id: z.string() }),
        body: { content: { 'application/json': { schema: UpdateSysGroupSchema } } },
      },
      responses: { 200: { description: 'SysGroup updated', content: { 'application/json': { schema: OkResponse(SysGroupSchema) } } } },
    }),
    async (c) => {
      requireRoot(c);
      const body = await UpdateSysGroupSchema.parse(c.req.json());
      return c.json(ok(await svc.update(c.req.param('id'), body, c.var.currentUser?.id)));
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/{id}',
      tags: ['system-groups'],
      summary: '删除系统权限组',
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: OkResponse(z.null()) } } } },
    }),
    async (c) => {
      requireRoot(c);
      await svc.delete(c.req.param('id'), c.var.currentUser?.id);
      return c.json(ok(null));
    },
  );

  return app;
}
