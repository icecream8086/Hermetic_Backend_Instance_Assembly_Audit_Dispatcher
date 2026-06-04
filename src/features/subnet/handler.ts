import { Hono } from 'hono';
import type { ISubnetService } from './service.ts';
import type { AppContext } from '../../core/app.ts';
import { ok, fail } from '../../core/response.ts';
import type { RouteMeta } from '../../core/http-docs/types.ts';
import type { CreateSubnetInput, UpdateSubnetInput } from './types.ts';

export function createSubnetRouter(svc: ISubnetService): Hono<{ Variables: AppContext }> {
  const router = new Hono<{ Variables: AppContext }>();

  router.get('/', async (c) => {
    const page = parseInt(c.req.query('page') ?? '') || 1;
    const limit = parseInt(c.req.query('limit') ?? '') || 20;
    const result = await svc.list(page, limit);
    return c.json(ok(result));
  });

  router.post('/', async (c) => {
    try {
      const body = await c.req.json<CreateSubnetInput>();
      if (!body.name || !body.cidr || body.subnetPrefix === undefined || !body.instanceId) {
        return c.json(fail('VALIDATION_ERROR', 'name, cidr, subnetPrefix, and instanceId are required'), 400);
      }
      const subnet = await svc.create(body);
      return c.json(ok(subnet), 201);
    } catch (e: any) {
      return c.json(fail('CREATE_FAILED', e.message), 400);
    }
  });

  router.get('/:id', async (c) => {
    const id = c.req.param('id') as any;
    const subnet = await svc.get(id);
    if (!subnet) return c.json(fail('NOT_FOUND', 'Subnet not found'), 404);
    return c.json(ok(subnet));
  });

  router.put('/:id', async (c) => {
    try {
      const id = c.req.param('id') as any;
      const body = await c.req.json<UpdateSubnetInput>();
      const subnet = await svc.update(id, body);
      return c.json(ok(subnet));
    } catch (e: any) {
      return c.json(fail('UPDATE_FAILED', e.message), e.status ?? 400);
    }
  });

  router.delete('/:id', async (c) => {
    try {
      const id = c.req.param('id') as any;
      await svc.delete(id);
      return c.json(ok(null));
    } catch (e: any) {
      return c.json(fail('DELETE_FAILED', e.message), e.status ?? 400);
    }
  });

  return router;
}

export const subnetRouteMeta: RouteMeta[] = [
  { method: 'GET', path: '/', description: '列出子网（分页）', responseDescription: '{ items: Subnet[], total, page, limit }' },
  { method: 'POST', path: '/', description: '创建子网', requestBody: { name: 'my-subnet', cidr: '10.2.0.0/16', subnetPrefix: 24, instanceId: 'inst_xxx' }, responseDescription: 'Subnet' },
  { method: 'GET', path: '/:id', description: '获取子网详情', responseDescription: 'Subnet' },
  { method: 'PUT', path: '/:id', description: '更新子网', responseDescription: 'Subnet' },
  { method: 'DELETE', path: '/:id', description: '删除子网', responseDescription: '{ ok: true }' },
];
