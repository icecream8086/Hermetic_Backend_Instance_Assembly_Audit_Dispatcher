import { Hono } from 'hono';
import type { IRunnerService } from './service.ts';
import { ok, fail } from '../../core/response.ts';
import type { RouteMeta } from '../../core/http-docs/types.ts';

function requireRoot(c: any): Response | null {
  const user = c.var?.currentUser;
  if (!user) return null;
  const isRoot = user.role === 'root' || user.role === 'Operator' || user.role === 'wheel';
  if (!isRoot) return c.json(fail('FORBIDDEN', 'Admin access required'), 403);
  return null;
}

export function createInstancesRouter(svc: IRunnerService): Hono<any> {
  const router = new Hono<any>();

  // ─── Runner CRUD ───

  router.post('/', async (c) => {
    const body = await c.req.json() as any;
    if (!body.name) return c.json(fail('VALIDATION_ERROR', 'name is required'), 400);
    const { runner, token } = await svc.register({
      name: body.name,
      os: body.os,
      labels: body.labels,
      providerInstanceId: body.providerInstanceId,
      groupIds: body.groupIds,
    });
    return c.json(ok({ runner, token }), 201);
  });

  router.get('/', async (c) => {
    const status = c.req.query('status');
    const runners = await svc.list(status);
    return c.json(ok({ items: runners, total: runners.length }));
  });

  router.get('/:id', async (c) => {
    const runner = await svc.get(c.req.param('id') as any);
    if (!runner) return c.json(fail('RUNNER_NOT_FOUND', 'Runner not found'), 404);
    return c.json(ok(runner));
  });

  router.put('/:id', async (c) => {
    const r = requireRoot(c); if (r) return r;
    const body = await c.req.json() as any;
    const updated = await svc.update(c.req.param('id') as any, body, c.var?.currentUser?.id);
    return c.json(ok(updated));
  });

  router.delete('/:id', async (c) => {
    const r = requireRoot(c); if (r) return r;
    await svc.delete(c.req.param('id') as any, c.var?.currentUser?.id);
    return c.json(ok(null));
  });

  // ─── Heartbeat ───

  router.post('/:id/heartbeat', async (c) => {
    const runner = await svc.heartbeat(c.req.param('id') as any);
    return c.json(ok(runner));
  });

  router.post('/mark-stale', async (c) => {
    const r = requireRoot(c); if (r) return r;
    const count = await svc.markStaleOffline();
    return c.json(ok({ markedOffline: count }));
  });

  // ─── Registration tokens ───

  router.post('/registration-token', async (c) => {
    const r = requireRoot(c); if (r) return r;
    const token = await svc.createRegistrationToken();
    return c.json(ok(token), 201);
  });

  router.post('/validate-token', async (c) => {
    const { token } = await c.req.json() as any;
    if (!token) return c.json(fail('VALIDATION_ERROR', 'token is required'), 400);
    const valid = await svc.validateRegistrationToken(token);
    return c.json(ok({ valid }));
  });

  // ─── Runner groups ───

  router.post('/groups', async (c) => {
    const r = requireRoot(c); if (r) return r;
    const body = await c.req.json() as any;
    if (!body.name) return c.json(fail('VALIDATION_ERROR', 'name is required'), 400);
    const group = await svc.createGroup(body, c.var?.currentUser?.id);
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
    const r = requireRoot(c); if (r) return r;
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
