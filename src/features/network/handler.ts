import { Hono } from 'hono';
import type { INetworkService } from './service.ts';
import { CreateNetworkSchema, UpdateNetworkSchema, NetworkQuerySchema } from './schema.ts';
import { ok, fail } from '../../core/response.ts';
import type { RouteMeta } from '../../core/http-docs/types.ts';

function requireRoot(c: any): Response | null {
  const user = c.var?.currentUser;
  if (!user) return null;
  const isRoot = user.role === 'root' || user.role === 'Operator' || user.role === 'wheel';
  if (!isRoot) return c.json(fail('FORBIDDEN', 'Admin access required'), 403);
  return null;
}

function actorFrom(c: any): string | undefined {
  return c.var?.currentUser?.id;
}

export function createNetworkRouter(svc: INetworkService): Hono<any> {
  const router = new Hono<any>();

  // POST / — create a virtual network (admin only)
  router.post('/', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    const body: unknown = await c.req.json();
    const parsed = CreateNetworkSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    }
    const network = await svc.create(parsed.data as any, actorFrom(c));
    return c.json(ok(network), 201);
  });

  // GET / — list virtual networks (paginated, filterable)
  router.get('/', async (c) => {
    const query = NetworkQuerySchema.safeParse({
      page: c.req.query('page'),
      limit: c.req.query('limit'),
      visibility: c.req.query('visibility'),
      provider: c.req.query('provider'),
      region: c.req.query('region'),
    });
    const q = query.data!;
    const result = await svc.list(q.page, q.limit, { visibility: q.visibility, provider: q.provider, region: q.region as any });
    return c.json(ok(result));
  });

  // GET /:id — get a single virtual network
  router.get('/:id', async (c) => {
    const id = c.req.param('id') as any;
    const network = await svc.get(id);
    if (!network) return c.json(fail('NETWORK_NOT_FOUND', 'Virtual network not found'), 404);
    return c.json(ok(network));
  });

  // PUT /:id — update a virtual network (admin only)
  router.put('/:id', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    const id = c.req.param('id') as any;
    const body: unknown = await c.req.json();
    const parsed = UpdateNetworkSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    }
    const network = await svc.update(id, parsed.data, actorFrom(c));
    return c.json(ok(network));
  });

  // DELETE /:id — delete a virtual network (admin only)
  router.delete('/:id', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    const id = c.req.param('id') as any;
    await svc.delete(id, actorFrom(c));
    return c.json(ok(null));
  });

  return router;
}

export const networkRouteMeta: RouteMeta[] = [
  { method: 'POST', path: '/', description: '创建虚拟网段 — 定义 CIDR 范围和子网粒度，可选择 provider 和 region', requestBody: { name: 'dev-network', cidr: '10.2.0.0/16', subnetPrefix: 24, provider: 'podman', region: 'local' }, responseDescription: 'VirtualNetwork' },
  { method: 'GET', path: '/', description: '列出所有虚拟网段（支持分页和过滤：?page=&limit=&visibility=&provider=&region=）', responseDescription: '{ items: VirtualNetwork[], total, page, limit }' },
  { method: 'GET', path: '/:id', description: '按 ID 获取虚拟网段详情', responseDescription: 'VirtualNetwork' },
  { method: 'PUT', path: '/:id', description: '更新虚拟网段（名称/描述/可见性/绑定用户组等）', requestBody: { name: 'updated-name', visibility: 'public' }, responseDescription: 'VirtualNetwork' },
  { method: 'DELETE', path: '/:id', description: '删除虚拟网段', responseDescription: '{ ok: true }' },
];
