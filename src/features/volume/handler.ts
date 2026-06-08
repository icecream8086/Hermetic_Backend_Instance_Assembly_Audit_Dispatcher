import { Hono } from 'hono';
import type { IVolumeService } from './service.ts';
import { CreateVolumeSchema, UpdateVolumeSchema } from './schema.ts';
import type { CreateVolumeInput, UpdateVolumeInput } from './types.ts';
import { ok, fail } from '../../core/response.ts';
import type { RouteMeta } from '../../core/http-docs/types.ts';

function requireRoot(c: any): Response | null {
  const user = c.var?.currentUser;
  if (!user) return null;
  const isRoot = user.role === 'root' || user.role === 'Operator' || user.role === 'wheel';
  if (!isRoot) return c.json(fail('FORBIDDEN', 'Admin access required'), 403);
  return null;
}

export function createVolumeRouter(svc: IVolumeService): Hono<any> {
  const router = new Hono<any>();

  router.post('/', async (c) => {
    const r = requireRoot(c); if (r) return r;
    const body: unknown = await c.req.json();
    const parsed = CreateVolumeSchema.safeParse(body);
    if (!parsed.success) return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    const volume = await svc.create(parsed.data as CreateVolumeInput);
    return c.json(ok(volume), 201);
  });

  router.get('/', async (c) => {
    const page = parseInt(c.req.query('page') ?? '') || 1;
    const limit = parseInt(c.req.query('limit') ?? '') || 50;
    const filters: Record<string, string> = {};
    const n = c.req.query('name'); if (n) filters.name = n;
    const t = c.req.query('type'); if (t) filters.type = t;
    const s = c.req.query('status'); if (s) filters.status = s;
    const inst = c.req.query('instanceId'); if (inst) filters.instanceId = inst;
    return c.json(ok(await svc.listPaginated(page, limit, Object.keys(filters).length ? filters : undefined)));
  });

  router.get('/:id', async (c) => {
    const vol = await svc.get(c.req.param('id'));
    if (!vol) return c.json(fail('VOLUME_NOT_FOUND', 'Volume not found'), 404);
    return c.json(ok(vol));
  });

  router.put('/:id', async (c) => {
    const r = requireRoot(c); if (r) return r;
    const body: unknown = await c.req.json();
    const parsed = UpdateVolumeSchema.safeParse(body);
    if (!parsed.success) return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    return c.json(ok(await svc.update(c.req.param('id'), parsed.data as UpdateVolumeInput)));
  });

  router.delete('/:id', async (c) => {
    const r = requireRoot(c); if (r) return r;
    await svc.delete(c.req.param('id'));
    return c.json(ok(null));
  });

  return router;
}

export const volumeRouteMeta: RouteMeta[] = [
  { method: 'POST', path: '/', description: '创建数据卷 — 必须绑定到计算实例 (instanceId)', requestBody: { name: 'my-volume', type: 'NFSVolume', instanceId: 'inst_xxx', nfs: { server: '192.168.1.1', path: '/data', readOnly: false } }, responseDescription: 'Volume' },
  { method: 'GET', path: '/', description: '列出数据卷 — 支持 ?name=&type=&status=&instanceId= 筛选', responseDescription: 'Volume[]' },
  { method: 'GET', path: '/:id', description: '按 ID 获取数据卷详情', responseDescription: 'Volume' },
  { method: 'PUT', path: '/:id', description: '更新数据卷配置', requestBody: { description: 'updated description' }, responseDescription: 'Volume' },
  { method: 'DELETE', path: '/:id', description: '删除数据卷', responseDescription: '{ ok: true }' },
];
