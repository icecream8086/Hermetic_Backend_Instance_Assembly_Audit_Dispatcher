import { Hono } from 'hono';
import type { ISubnetService } from './service.ts';
import type { AppContext } from '../../core/deps.ts';
import { ok, fail } from '../../core/response.ts';
import type { RouteMeta } from '../../core/http-docs/types.ts';
import type { CreateSubnetInput, UpdateSubnetInput } from './types.ts';
import type { CrudHandlerMap } from '../../core/crud/router.ts';
import { registerCrudRoutes } from '../../core/crud/router.ts';

export function createSubnetRouter(svc: ISubnetService): Hono<{ Variables: AppContext }> {
  const router = new Hono<{ Variables: AppContext }>();

  const crud: CrudHandlerMap = {
    list: (r) => r.get('/', async (c) => {
      const page = parseInt(c.req.query('page') ?? '') || 1;
      const limit = parseInt(c.req.query('limit') ?? '') || 20;
      const name = c.req.query('name');
      const result = await svc.list(page, limit, name);
      return c.json(ok(result));
    }),

    create: (r) => r.post('/', async (c) => {
      try {
        const body = await c.req.json<CreateSubnetInput>();
        if (!body.name || !body.cidr || body.subnetPrefix === undefined || !body.instanceId) {
          return c.json(fail('VALIDATION_ERROR', 'name, cidr, subnetPrefix, and instanceId are required'), 400);
        }
        const actorId = c.var?.currentUser?.id;
        const subnet = await svc.create(body, actorId);
        return c.json(ok(subnet), 201);
      } catch (e: any) {
        return c.json(fail('CREATE_FAILED', e.message), 400);
      }
    }),

    get: (r) => r.get('/:id', async (c) => {
      const id = c.req.param('id') as any;
      const subnet = await svc.get(id);
      if (!subnet) return c.json(fail('NOT_FOUND', 'Subnet not found'), 404);
      return c.json(ok(subnet));
    }),

    update: (r) => r.put('/:id', async (c) => {
      try {
        const id = c.req.param('id') as any;
        const body = await c.req.json<UpdateSubnetInput>();
        const actorId = c.var?.currentUser?.id;
        const subnet = await svc.update(id, body, actorId);
        return c.json(ok(subnet));
      } catch (e: any) {
        return c.json(fail('UPDATE_FAILED', e.message), e.status ?? 400);
      }
    }),

    delete: (r) => r.delete('/:id', async (c) => {
      try {
        const id = c.req.param('id') as any;
        const actorId = c.var?.currentUser?.id;
        await svc.delete(id, actorId);
        return c.json(ok(null));
      } catch (e: any) {
        return c.json(fail('DELETE_FAILED', e.message), e.status ?? 400);
      }
    }),
  };

  return registerCrudRoutes(router, crud);
}

export const subnetRouteMeta: RouteMeta[] = [
  { method: 'GET', path: '/', description: '列出子网（分页）', responseDescription: '{ items: Subnet[], total, page, limit }' },
  { method: 'POST', path: '/', description: '创建子网', requestBody: { name: 'my-subnet', cidr: '10.2.0.0/16', subnetPrefix: 24, instanceId: 'inst_xxx' }, responseDescription: 'Subnet' },
  { method: 'GET', path: '/:id', description: '获取子网详情', responseDescription: 'Subnet' },
  { method: 'PUT', path: '/:id', description: '更新子网', responseDescription: 'Subnet' },
  { method: 'DELETE', path: '/:id', description: '删除子网', responseDescription: '{ ok: true }' },
];
