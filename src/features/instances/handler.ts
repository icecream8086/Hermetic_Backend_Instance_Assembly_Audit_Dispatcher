import { Hono } from 'hono';
import type { Context } from 'hono';
import type { IRunnerService } from './service.ts';
import type { AppContext } from "../../core/deps.ts";
import { CreateRunnerSchema, UpdateRunnerSchema, CreateRunnerGroupSchema, ValidateTokenSchema } from './schema.ts';
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

export function createInstancesRouter(svc: IRunnerService): Hono<any> {
  const router = new Hono<any>();

  const crud: CrudHandlerMap = {
    create: (r) => r.post('/', async (c) => {
      const body: unknown = await c.req.json();
      const parsed = CreateRunnerSchema.safeParse(body);
      if (!parsed.success) return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
      const { runner, token } = await svc.register(parsed.data);
      return c.json(ok({ runner, token }), 201);
    }),

    list: (r) => r.get('/', async (c) => {
      const status = c.req.query('status');
      const runners = await svc.list(status);
      return c.json(ok({ items: runners, total: runners.length }));
    }),

    get: (r) => r.get('/:id', async (c) => {
      const runner = await svc.get(c.req.param('id') as any);
      if (!runner) return c.json(fail('RUNNER_NOT_FOUND', 'Runner not found'), 404);
      return c.json(ok(runner));
    }),

    update: (r) => r.put('/:id', async (c) => {
      const rv = requireRoot(c); if (rv) return rv;
      const body: unknown = await c.req.json();
      const parsed = UpdateRunnerSchema.safeParse(body);
      if (!parsed.success) return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
      const updated = await svc.update(c.req.param('id') as any, parsed.data, c.var?.currentUser?.id);
      return c.json(ok(updated));
    }),

    delete: (r) => r.delete('/:id', async (c) => {
      const rv = requireRoot(c); if (rv) return rv;
      await svc.delete(c.req.param('id') as any, c.var?.currentUser?.id);
      return c.json(ok(null));
    }),
  };

  registerCrudRoutes(router, crud);

  // ─── Heartbeat ───
  router.post('/:id/heartbeat', async (c) => {
    const runner = await svc.heartbeat(c.req.param('id') as any);
    return c.json(ok(runner));
  });

  router.post('/mark-stale', async (c) => {
    const rv = requireRoot(c); if (rv) return rv;
    const count = await svc.markStaleOffline();
    return c.json(ok({ markedOffline: count }));
  });

  // ─── Registration tokens ───
  router.post('/registration-token', async (c) => {
    const rv = requireRoot(c); if (rv) return rv;
    const token = await svc.createRegistrationToken();
    return c.json(ok(token), 201);
  });

  router.post('/validate-token', async (c) => {
    const body: unknown = await c.req.json();
    const parsed = ValidateTokenSchema.safeParse(body);
    if (!parsed.success) return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    const valid = await svc.validateRegistrationToken(parsed.data.token);
    return c.json(ok({ valid }));
  });

  // ─── Runner groups (partial CRUD — no PUT) ───
  router.post('/groups', async (c) => {
    const rv = requireRoot(c); if (rv) return rv;
    const body: unknown = await c.req.json();
    const parsed = CreateRunnerGroupSchema.safeParse(body);
    if (!parsed.success) return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    const group = await svc.createGroup(parsed.data, c.var?.currentUser?.id);
    return c.json(ok(group), 201);
  });

  router.get('/groups', async (c) => {
    const groups = await svc.listGroups();
    return c.json(ok({ items: groups, total: groups.length }));
  });

  router.get('/groups/:id', async (c) => {
    const group = await svc.getGroup(c.req.param('id') as any);
    if (!group) return c.json(fail('RUNNER_GROUP_NOT_FOUND', 'Runner group not found'), 404);
    return c.json(ok(group));
  });

  router.delete('/groups/:id', async (c) => {
    const rv = requireRoot(c); if (rv) return rv;
    await svc.deleteGroup(c.req.param('id') as any, c.var?.currentUser?.id);
    return c.json(ok(null));
  });

  return router;
}

export const instancesRouteMeta: RouteMeta[] = [
  { method: 'POST', path: '/', description: '注册新 Runner（GitHub Runner 模型），返回 registration token', requestBody: { name: 'worker-1', os: 'linux', labels: ['gpu'] }, responseDescription: '{ runner, token }' },
  { method: 'GET', path: '/', description: '列出所有 Runner（?status=online|offline）', responseDescription: '{ items: RunnerInstance[] }' },
  { method: 'GET', path: '/:id', description: '获取 Runner 详情', responseDescription: 'RunnerInstance' },
  { method: 'PUT', path: '/:id', description: '更新 Runner（名称/标签/组）', responseDescription: 'RunnerInstance' },
  { method: 'DELETE', path: '/:id', description: '删除 Runner', responseDescription: '{ ok: true }' },
  { method: 'POST', path: '/:id/heartbeat', description: 'Runner 心跳上报，更新 lastHeartbeatAt + 恢复 online', responseDescription: 'RunnerInstance' },
  { method: 'POST', path: '/mark-stale', description: '标记超时 Runner 为 offline（>5min 无心跳）', responseDescription: '{ markedOffline: number }' },
  { method: 'POST', path: '/registration-token', description: '创建注册 token（1h TTL）', responseDescription: 'RegistrationToken' },
  { method: 'POST', path: '/validate-token', description: '验证并消费注册 token（一次性）', requestBody: { token: 'rtok_...' }, responseDescription: '{ valid: boolean }' },
  { method: 'POST', path: '/groups', description: '创建 Runner 组', requestBody: { name: 'gpu-pool', visibility: 'selected', selectedScopeIds: ['proj_1'] }, responseDescription: 'RunnerGroup' },
  { method: 'GET', path: '/groups', description: '列出所有 Runner 组', responseDescription: '{ items: RunnerGroup[] }' },
  { method: 'GET', path: '/groups/:id', description: '获取 Runner 组详情', responseDescription: 'RunnerGroup' },
  { method: 'DELETE', path: '/groups/:id', description: '删除 Runner 组', responseDescription: '{ ok: true }' },
];
