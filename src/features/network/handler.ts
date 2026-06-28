import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ISecurityGroupService } from './service.ts';
import type { AppContext } from "../../core/deps.ts";
import { ok, fail } from '../../core/response.ts';
import type { RouteMeta } from '../../core/http-docs/types.ts';
import type { CreateSecurityGroupInput, UpdateSecurityGroupInput } from './types.ts';
import type { CrudHandlerMap } from '../../core/crud/router.ts';
import { registerCrudRoutes } from '../../core/crud/router.ts';

function requireRoot(c: Context<{ Variables: AppContext }>): Response | null {
  const user = c.var?.currentUser;
  if (!user) return null;
  const isRoot = user.role === 'root' || user.role === 'Operator' || user.role === 'wheel';
  if (!isRoot) return c.json(fail('FORBIDDEN', 'Admin access required'), 403);
  return null;
}

function actorFrom(c: any): string | undefined {
  return c.var?.currentUser?.id;
}

export function createSecurityGroupRouter(svc: ISecurityGroupService): Hono<any> {
  const router = new Hono<any>();

  const crud: CrudHandlerMap = {
    list: (r) => r.get('/', async (c) => {
      const page = parseInt(c.req.query('page') ?? '') || 1;
      const limit = parseInt(c.req.query('limit') ?? '') || 20;
      const name = c.req.query('name');
      const result = await svc.list(page, limit, name);
      return c.json(ok(result));
    }),

    create: (r) => r.post('/', async (c) => {
      { const rv = requireRoot(c); if (rv) return rv; }
      const body = await c.req.json<CreateSecurityGroupInput>();
      if (!body.name || !body.instanceId) return c.json(fail('VALIDATION_ERROR', 'name and instanceId are required'), 400);
      const sg = await svc.create(body, actorFrom(c));
      return c.json(ok(sg), 201);
    }),

    get: (r) => r.get('/:id', async (c) => {
      const id = c.req.param('id') as any;
      const sg = await svc.get(id);
      if (!sg) return c.json(fail('NOT_FOUND', 'Security group not found'), 404);
      return c.json(ok(sg));
    }),

    update: (r) => r.put('/:id', async (c) => {
      { const rv = requireRoot(c); if (rv) return rv; }
      const id = c.req.param('id') as any;
      const body = await c.req.json<UpdateSecurityGroupInput>();
      const sg = await svc.update(id, body, actorFrom(c));
      return c.json(ok(sg));
    }),

    delete: (r) => r.delete('/:id', async (c) => {
      { const rv = requireRoot(c); if (rv) return rv; }
      const id = c.req.param('id') as any;
      await svc.delete(id, actorFrom(c));
      return c.json(ok(null));
    }),
  };

  return registerCrudRoutes(router, crud);
}

/** @deprecated 改用 createSecurityGroupRouter */
export const createNetworkRouter = createSecurityGroupRouter;

export const networkRouteMeta: RouteMeta[] = [
  { method: 'GET', path: '/', description: '列出安全组（分页）', responseDescription: '{ items: SecurityGroup[], total, page, limit }' },
  { method: 'POST', path: '/', description: '创建安全组', requestBody: { name: 'my-sg', instanceId: 'inst_xxx' }, responseDescription: 'SecurityGroup' },
  { method: 'GET', path: '/:id', description: '获取安全组详情', responseDescription: 'SecurityGroup' },
  { method: 'PUT', path: '/:id', description: '更新安全组', responseDescription: 'SecurityGroup' },
  { method: 'DELETE', path: '/:id', description: '删除安全组', responseDescription: '{ ok: true }' },
];
