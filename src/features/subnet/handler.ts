import { z } from 'zod';
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { ISubnetService } from './service.ts';
import { AppError } from '../../core/types.ts';
import type { AppContext } from '../../core/deps.ts';
import { ok } from '../../core/response.ts';
import { OkResponse } from '../../core/http-docs/response-schema.ts';
import type { CreateSubnetInput, UpdateSubnetInput } from './types.ts';

export function createSubnetRouter(svc: ISubnetService): OpenAPIHono<{ Variables: AppContext }> {
  const app = new OpenAPIHono<{ Variables: AppContext }>();

  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['subnets'],
      summary: '列出子网（分页）',
      responses: { 200: { description: '{ items: Subnet[], total, page, limit }', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } },
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
      tags: ['subnets'],
      summary: '创建子网',
      responses: { 201: { description: 'Subnet', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } },
    }),
    async (c) => {
      const body = await c.req.json<CreateSubnetInput>();
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- API boundary: runtime data may differ from types
      if (!body.name || !body.cidr || body.subnetPrefix === undefined || !body.instanceId) {
        throw new AppError(400, 'VALIDATION_ERROR', 'name, cidr, subnetPrefix, and instanceId are required');
      }
      const actorId = c.var.currentUser?.id;
      const subnet = await svc.create(body, actorId);
      return c.json(ok(subnet), 201);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/{id}',
      tags: ['subnets'],
      summary: '获取子网详情',
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: { description: 'Subnet', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } },
    }),
    async (c) => {
      const id = c.req.param('id') as any;
      const subnet = await svc.get(id);
      if (!subnet) throw new AppError(404, 'NOT_FOUND', 'Subnet not found');
      return c.json(ok(subnet));
    },
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/{id}',
      tags: ['subnets'],
      summary: '更新子网',
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: { description: 'Subnet', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } },
    }),
    async (c) => {
      const id = c.req.param('id') as any;
      const body = await c.req.json<UpdateSubnetInput>();
      const actorId = c.var.currentUser?.id;
      const subnet = await svc.update(id, body, actorId);
      return c.json(ok(subnet));
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/{id}',
      tags: ['subnets'],
      summary: '删除子网',
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } },
    }),
    async (c) => {
      const id = c.req.param('id') as any;
      const actorId = c.var.currentUser?.id;
      await svc.delete(id, actorId);
      return c.json(ok(null));
    },
  );

  return app;
}
