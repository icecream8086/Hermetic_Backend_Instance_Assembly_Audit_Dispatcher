import { z } from 'zod';
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { ISecurityGroupService } from './service.ts';
import { AppError } from '../../core/types.ts';
import type { AppContext } from '../../core/deps.ts';
import { ok } from '../../core/response.ts';
import { OkResponse, PaginatedResponse } from '../../core/http-docs/response-schema.ts';
import { SecurityGroupSchema } from './response-schema.ts';
import type { CreateSecurityGroupInput, UpdateSecurityGroupInput } from './types.ts';

function requireRoot<E extends { Variables: { currentUser?: { role?: string } } }>(c: Context<E>): void {
  const user = c.var.currentUser;
  if (!user || !['root', 'Operator', 'wheel'].includes(user.role)) {
    throw new AppError(403, 'FORBIDDEN', 'Admin access required');
  }
}

function actorFrom(c: any): string | undefined {
  return c.var?.currentUser?.id;
}

export function createSecurityGroupRouter(svc: ISecurityGroupService): OpenAPIHono<{ Variables: AppContext }> {
  const app = new OpenAPIHono<{ Variables: AppContext }>();

  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['networks'],
      summary: '列出安全组（分页）',
      responses: { 200: { description: '{ items: SecurityGroup[], total, page, limit }', content: { 'application/json': { schema: PaginatedResponse(SecurityGroupSchema) } } } },
    }),
    async (c) => {
      const page = parseInt(c.req.query('page') ?? '') || 1;
      const limit = parseInt(c.req.query('limit') ?? '') || 20;
      const name = c.req.query('name');
      const result = await svc.list(page, limit, name);
      return c.json(ok(result));
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['networks'],
      summary: '创建安全组',
      responses: { 201: { description: 'SecurityGroup', content: { 'application/json': { schema: OkResponse(SecurityGroupSchema) } } } },
    }),
    async (c) => {
      requireRoot(c);
      const body = await z.unknown().parse(c.req.json());
      if (!body.name || !body.instanceId) throw new AppError(400, 'VALIDATION_ERROR', 'name and instanceId are required');
      const sg = await svc.create(body, actorFrom(c));
      return c.json(ok(sg), 201);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/{id}',
      tags: ['networks'],
      summary: '获取安全组详情',
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: { description: 'SecurityGroup', content: { 'application/json': { schema: OkResponse(SecurityGroupSchema) } } } },
    }),
    async (c) => {
      const id = c.req.param('id') as any;
      const sg = await svc.get(id);
      if (!sg) throw new AppError(404, 'NOT_FOUND', 'Security group not found');
      return c.json(ok(sg));
    },
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/{id}',
      tags: ['networks'],
      summary: '更新安全组',
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: { description: 'SecurityGroup', content: { 'application/json': { schema: OkResponse(SecurityGroupSchema) } } } },
    }),
    async (c) => {
      requireRoot(c);
      const id = c.req.param('id') as any;
      const body = await z.unknown().parse(c.req.json());
      const sg = await svc.update(id, body, actorFrom(c));
      return c.json(ok(sg));
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/{id}',
      tags: ['networks'],
      summary: '删除安全组',
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: OkResponse(z.null()) } } } },
    }),
    async (c) => {
      requireRoot(c);
      const id = c.req.param('id') as any;
      await svc.delete(id, actorFrom(c));
      return c.json(ok(null));
    },
  );

  return app;
}

/** @deprecated 改用 createSecurityGroupRouter */
export const createNetworkRouter = createSecurityGroupRouter;
