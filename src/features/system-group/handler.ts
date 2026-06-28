import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ISysGroupService } from './service.ts';
import type { AppContext } from "../../core/deps.ts";
import { CreateSysGroupSchema, UpdateSysGroupSchema } from './schema.ts';
import { ok, fail } from '../../core/response.ts';
import type { RouteMeta } from '../../core/http-docs/types.ts';
import type { CrudHandlerMap } from '../../core/crud/router.ts';
import { registerCrudRoutes } from '../../core/crud/router.ts';

function requireRoot(c: Context<{ Variables: AppContext }>): Response | null {
  const user = c.var?.currentUser;
  if (!user) return null;
  const isRoot = user.role === 'root' || user.role === 'Operator' || user.role === 'wheel';
  if (!isRoot) return c.json(fail('FORBIDDEN', 'Admin access required'), 403);
  return null;
}

export function createSysGroupRouter(svc: ISysGroupService): Hono<any> {
  const router = new Hono<any>();

  const crud: CrudHandlerMap = {
    create: (r) => r.post('/', async (c) => {
      const rv = requireRoot(c); if (rv) return rv;
      const body: unknown = await c.req.json();
      const parsed = CreateSysGroupSchema.safeParse(body);
      if (!parsed.success) return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
      const group = await svc.create(parsed.data, c.var?.currentUser?.id);
      return c.json(ok(group), 201);
    }),

    list: (r) => r.get('/', async (c) => {
      const rv = requireRoot(c); if (rv) return rv;
      const page = parseInt(c.req.query('page') ?? '') || 1;
      const limit = parseInt(c.req.query('limit') ?? '') || 50;
      const name = c.req.query('name');
      const { items, total } = await svc.listPaginated(page, limit, name);
      return c.json(ok({ items, total, page, limit }));
    }),

    get: (r) => r.get('/:id', async (c) => {
      const rv = requireRoot(c); if (rv) return rv;
      const group = await svc.get(c.req.param('id'));
      if (!group) return c.json(fail('SYSGROUP_NOT_FOUND', 'System group not found'), 404);
      return c.json(ok(group));
    }),

    update: (r) => r.put('/:id', async (c) => {
      const rv = requireRoot(c); if (rv) return rv;
      const body: unknown = await c.req.json();
      const parsed = UpdateSysGroupSchema.safeParse(body);
      if (!parsed.success) return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
      return c.json(ok(await svc.update(c.req.param('id'), parsed.data, c.var?.currentUser?.id)));
    }),

    delete: (r) => r.delete('/:id', async (c) => {
      const rv = requireRoot(c); if (rv) return rv;
      await svc.delete(c.req.param('id'), c.var?.currentUser?.id);
      return c.json(ok(null));
    }),
  };

  return registerCrudRoutes(router, crud);
}

export const sysGroupRouteMeta: RouteMeta[] = [
  { method: 'POST', path: '/', description: '创建系统权限组 — 全局规则，不绑定用户/组。dependsOn 支持 DAG 继承父组规则', requestBody: { name: 'sys.custom', rules: [{ effect: 'allow', actions: ['read'], priority: 10 }] }, responseDescription: 'SysGroup' },
  { method: 'GET', path: '/', description: '列出所有系统权限组（含种子数据：perm.sysadmin / perm.operator / perm.viewer / perm.auth）', responseDescription: 'SysGroup[]' },
  { method: 'GET', path: '/:id', description: '按 ID 获取系统权限组详情（含规则和依赖链）', responseDescription: 'SysGroup' },
  { method: 'PUT', path: '/:id', description: '更新系统权限组（名称/规则/priority/dependsOn）', requestBody: { priority: 200 }, responseDescription: 'SysGroup' },
  { method: 'DELETE', path: '/:id', description: '删除系统权限组', responseDescription: '{ ok: true }' },
];
