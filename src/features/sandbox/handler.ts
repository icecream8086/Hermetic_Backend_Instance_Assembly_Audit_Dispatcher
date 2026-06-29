import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ISandboxService } from './interfaces.ts';
import { createSandboxId } from './types.ts';
import type { CreateSandboxInput } from './types.ts';
import type { PodSpec } from '../../core/pod/types.ts';
import { createPodId } from '../../core/pod/types.ts';
import type { PodService } from '../../core/pod/service.ts';
import type { IProviderRegistry } from '../../core/provider/interfaces.ts';
import type { RouteMeta } from '../../core/http-docs/types.ts';
import type { AppContext } from '../../core/deps.ts';
import { ok, fail } from '../../core/response.ts';
import type { ErrorCode } from '../../core/error-codes.ts';

interface PermissionCheckFn { check(params: { userId: string; action: string; resource: string; ip?: string }): Promise<{ allowed: boolean; reason: string }> }

function errorStatus(e: unknown, fallbackCode: ErrorCode, fallbackStatus = 500): { code: ErrorCode; status: number } {
  const err = e as Record<string, unknown> | undefined;
  const status = typeof err?.statusCode === 'number' ? err.statusCode : typeof err?.status === 'number' ? err.status : fallbackStatus;
  const code = (typeof err?.code === 'string' ? err.code as ErrorCode : undefined) ?? fallbackCode;
  return { code, status };
}

interface SandboxEnv { Variables: AppContext }

async function requirePerm(c: Context<SandboxEnv>, checker: PermissionCheckFn | undefined, action: string, resource: string, resourceOwnerId?: string): Promise<Response | null> {
  if (!checker) return null;
  const user = c.var.currentUser;
  if (!user) return null;
  const result = await checker.check({ userId: user.id, action, resource, ...(resourceOwnerId ? { resourceOwnerId } : {}) });
  if (!result.allowed) return c.json(fail('FORBIDDEN', result.reason), 403);
  return null;
}

export function createSandboxRouter(
  svc: ISandboxService,
  _providers: IProviderRegistry,
  permissionChecker?: PermissionCheckFn,
  podService?: PodService,
): Hono<{ Variables: AppContext }> {
  const router = new Hono<{ Variables: AppContext }>();

  // ─── Container group (Pod) API — K8s-aligned, PodService-backed ───

  // POST /pod — create a pod from K8s-aligned PodSpec (persisted + state machine)
  router.post('/pod', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'create', 'sandbox'); if (r) return r; }
    if (!podService) return c.json(fail('NOT_CONFIGURED', 'PodService not available'), 501);
    try {
      const spec = await c.req.json<PodSpec>();
      if (!spec.metadata?.name || !spec.spec?.containers?.length) {
        return c.json(fail('VALIDATION_ERROR', 'PodSpec requires metadata.name and spec.containers'), 400);
      }
      const pod = await podService.provision(spec);
      return c.json(ok({ podId: pod.podId, providerId: pod.providerId, phase: pod.phase, name: pod.name }), 201);
    } catch (e: unknown) {
      const { code, status } = errorStatus(e, 'POD_CREATE_FAILED');
      return c.json(fail(code, e.message), status);
    }
  });

  // GET /pod — list persisted pods
  router.get('/pod', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'read', 'sandbox'); if (r) return r; }
    if (!podService) return c.json(fail('NOT_CONFIGURED', 'PodService not available'), 501);
    try {
      const phase = c.req.query('phase') || undefined;
      const limit = parseInt(c.req.query('limit') ?? '50');
      const cursor = c.req.query('cursor');
      const result = await podService.list(phase, limit, cursor);
      return c.json(ok(result));
    } catch (e: unknown) {
      const { code, status } = errorStatus(e, 'POD_LIST_FAILED');
      return c.json(fail(code, e.message), status);
    }
  });

  // GET /pod/:id — get a single pod by PodId
  router.get('/pod/:id', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'read', 'sandbox'); if (r) return r; }
    if (!podService) return c.json(fail('NOT_CONFIGURED', 'PodService not available'), 501);
    try {
      const podId = createPodId(c.req.param('id'));
      const pod = await podService.getById(podId);
      if (!pod) return c.json(fail('POD_NOT_FOUND', 'Pod not found'), 404);
      return c.json(ok(pod));
    } catch (e: unknown) {
      const { code, status } = errorStatus(e, 'POD_GET_FAILED');
      return c.json(fail(code, e.message), status);
    }
  });

  // POST /pod/:id/stop — stop a pod (phase transition)
  router.post('/pod/:id/stop', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'update', 'sandbox'); if (r) return r; }
    if (!podService) return c.json(fail('NOT_CONFIGURED', 'PodService not available'), 501);
    try {
      const podId = createPodId(c.req.param('id'));
      const pod = await podService.stop(podId);
      return c.json(ok({ podId: pod.podId, phase: pod.phase }));
    } catch (e: unknown) {
      const { code, status } = errorStatus(e, 'POD_STOP_FAILED', 409);
      return c.json(fail(code, e.message), status);
    }
  });

  // DELETE /pod/:id — terminate a pod (Terminating → Deleted)
  router.delete('/pod/:id', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'delete', 'sandbox'); if (r) return r; }
    if (!podService) return c.json(fail('NOT_CONFIGURED', 'PodService not available'), 501);
    try {
      const podId = createPodId(c.req.param('id'));
      await podService.terminate(podId);
      return c.json(ok(null));
    } catch (e: unknown) {
      const { code, status } = errorStatus(e, 'POD_DELETE_FAILED', 404);
      return c.json(fail(code, e.message), status);
    }
  });

  // POST /pod/:id/sync — sync runtime state from provider
  router.post('/pod/:id/sync', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'update', 'sandbox'); if (r) return r; }
    if (!podService) return c.json(fail('NOT_CONFIGURED', 'PodService not available'), 501);
    try {
      const podId = createPodId(c.req.param('id'));
      const pod = await podService.syncRuntime(podId);
      return c.json(ok(pod));
    } catch (e: unknown) {
      const { code, status } = errorStatus(e, 'SYNC_FAILED', 502);
      return c.json(fail(code, e.message), status);
    }
  });

  // GET /pod/:id/logs — container logs
  router.get('/pod/:id/logs', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'read', 'sandbox'); if (r) return r; }
    if (!podService) return c.json(fail('NOT_CONFIGURED', 'PodService not available'), 501);
    try {
      const podId = createPodId(c.req.param('id'));
      const containerName = c.req.query('container') ?? '';
      if (!containerName) return c.json(fail('VALIDATION_ERROR', 'Query parameter "container" is required'), 400);
      const limitBytesRaw = c.req.query('limitBytes');
      const sinceSecondsRaw = c.req.query('sinceSeconds');
      const timestamps = c.req.query('timestamps') === 'true' ? true : undefined;
      const options: { limitBytes?: number; sinceSeconds?: number; timestamps?: boolean } = {};
      if (limitBytesRaw) options.limitBytes = parseInt(limitBytesRaw);
      if (sinceSecondsRaw) options.sinceSeconds = parseInt(sinceSecondsRaw);
      if (timestamps !== undefined) options.timestamps = timestamps;
      const result = await podService.getLogs(podId, containerName, options);
      return c.json(ok(result));
    } catch (e: unknown) {
      const { code, status } = errorStatus(e, 'POD_LOGS_FAILED');
      return c.json(fail(code, e.message), status);
    }
  });

  // POST /pod/:id/exec — create exec instance (returns WebSocket URI for interactive sessions)
  router.post('/pod/:id/exec', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'update', 'sandbox'); if (r) return r; }
    if (!podService) return c.json(fail('NOT_CONFIGURED', 'PodService not available'), 501);
    try {
      const podId = createPodId(c.req.param('id'));
      const body = await c.req.json<{ cmd: string[]; containerName?: string }>();
      if (!body.cmd?.length) return c.json(fail('VALIDATION_ERROR', 'Body.cmd (string array) is required'), 400);
      const result = await podService.exec(podId, body.cmd, body.containerName);
      return c.json(ok(result));
    } catch (e: unknown) {
      const { code, status } = errorStatus(e, 'POD_EXEC_FAILED');
      return c.json(fail(code, e.message), status);
    }
  });

  // PATCH /pod/:id — partial PodSpec update
  router.patch('/pod/:id', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'update', 'sandbox'); if (r) return r; }
    if (!podService) return c.json(fail('NOT_CONFIGURED', 'PodService not available'), 501);
    try {
      const podId = createPodId(c.req.param('id'));
      // eslint-disable-next-line @typescript-eslint/no-restricted-types -- HTTP JSON body: naturally a subset of PodSpec fields
      const specPatch = await c.req.json<Partial<PodSpec>>();
      const updated = await podService.update(podId, specPatch);
      return c.json(ok(updated));
    } catch (e: unknown) {
      const { code, status } = errorStatus(e, 'POD_UPDATE_FAILED', 409);
      return c.json(fail(code, e.message), status);
    }
  });

  // ─── Sandbox API (v1, single-container) ───

  router.get('/', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'read', 'sandbox'); if (r) return r; }
    const status = c.req.query('status') || undefined;
    const apiVer = c.req.query('apiVersion');
    const podPhase = c.req.query('podPhase')! || undefined;
    const limit = parseInt(c.req.query('limit') ?? '50');
    const cursor = c.req.query('cursor');
    let result = await svc.list?.(status, limit, cursor) ?? { items: [] };
    if (apiVer) {
      result = { ...result, items: result.items.filter(s => s.config.apiVersion === apiVer) };
    } else {
      result = { ...result, items: result.items.filter(s => s.config.apiVersion !== 'hbi-aad/v2') };
    }
    // Enrich with podPhase when PodService is available
    if (podService && result.items.length > 0) {
      const enriched = await Promise.all(result.items.map(async s => {
        const podUid = (s as unknown as Record<string, unknown>).podUid as string | undefined;
        if (!podUid) return { ...s, podPhase: null };
        try {
          const pod = await podService.getById(createPodId(podUid));
          return { ...s, podPhase: pod?.phase ?? null };
        } catch { return { ...s, podPhase: null }; }
      }));
      if (podPhase) {
        result = { ...result, items: enriched.filter(s => (s as Record<string, unknown>).podPhase === podPhase) };
      } else {
        result = { ...result, items: enriched };
      }
    }
    return c.json(ok(result));
  });

  router.get('/:id', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'read', 'sandbox'); if (r) return r; }
    const id = createSandboxId(c.req.param('id'));
    const sandbox = await svc.getById(id);
    if (!sandbox) return c.json(fail('SANDBOX_NOT_FOUND', 'Sandbox not found'), 404);
    // Project podPhase from PodService when available
    let podPhase: string | null = null;
    if (podService) {
      const podUid = (sandbox as unknown as Record<string, unknown>).podUid as string | undefined;
      if (podUid) {
        try {
          const pod = await podService.getById(createPodId(podUid));
          podPhase = pod?.phase ?? null;
        } catch { podPhase = null; }
      }
    }
    return c.json(ok({ ...sandbox, podPhase }));
  });

  router.post('/:id/stop', async (c) => {
    const id = createSandboxId(c.req.param('id'));
    const sandbox = await svc.getById(id);
    const ownerId = sandbox?.config?.creatorId;
    { const r = await requirePerm(c, permissionChecker, 'update', 'sandbox', ownerId); if (r) return r; }
    try {
      const stopped = await svc.stop(id);
      return c.json(ok(stopped));
    } catch (e: unknown) {
      const { code, status } = errorStatus(e, 'STOP_FAILED', 409);
      return c.json(fail(code, e.message), status);
    }
  });

  router.post('/:id/start', async (c) => {
    const id = createSandboxId(c.req.param('id'));
    const sandbox = await svc.getById(id);
    const ownerId = sandbox?.config?.creatorId;
    { const r = await requirePerm(c, permissionChecker, 'update', 'sandbox', ownerId); if (r) return r; }
    try {
      if (!svc.start) return c.json(fail('START_FAILED', 'Start not supported by this service'), 501);
      const started = await svc.start(id);
      return c.json(ok(started));
    } catch (e: unknown) {
      const { code, status } = errorStatus(e, 'START_FAILED', 409);
      return c.json(fail(code, e.message), status);
    }
  });

  router.delete('/:id', async (c) => {
    const id = createSandboxId(c.req.param('id'));
    const sandbox = await svc.getById(id);
    const ownerId = sandbox?.config?.creatorId;
    const actorId = c.var.currentUser?.id;
    { const r = await requirePerm(c, permissionChecker, 'delete', 'sandbox', ownerId); if (r) return r; }
    try {
      await svc.terminate(id, actorId);
      return c.json(ok(null));
    } catch (e: unknown) {
      const { code, status } = errorStatus(e, 'DELETE_FAILED', 404);
      return c.json(fail(code, e.message), status);
    }
  });

  router.post('/:id/sync', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'update', 'sandbox'); if (r) return r; }
    const id = createSandboxId(c.req.param('id'));
    try {
      const runtime = await svc.syncRuntime(id);
      const updated = await svc.getById(id);
      return c.json(ok({ runtime, sandbox: updated }), 200);
    } catch (e: unknown) {
      const { code, status } = errorStatus(e, 'SYNC_FAILED', 502);
      return c.json(fail(code, e.message), status);
    }
  });

  router.get('/:id/health', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'read', 'sandbox'); if (r) return r; }
    const id = createSandboxId(c.req.param('id'));
    try {
      const health = await svc.getHealth(id);
      return c.json(ok(health));
    } catch (e: unknown) {
      return c.json(fail('HEALTH_FAILED', e.message), e.status ?? 500);
    }
  });

  router.post('/:id/restart', async (c) => {
    const id = createSandboxId(c.req.param('id'));
    const sandbox = await svc.getById(id);
    const ownerId = sandbox?.config?.creatorId;
    { const r = await requirePerm(c, permissionChecker, 'update', 'sandbox', ownerId); if (r) return r; }
    try {
      const result = await svc.restart(id);
      return c.json(ok(result));
    } catch (e: unknown) {
      const { code, status } = errorStatus(e, 'RESTART_FAILED', 409);
      return c.json(fail(code, e.message), status);
    }
  });

  router.patch('/:id', async (c) => {
    const id = createSandboxId(c.req.param('id'));
    const sandbox = await svc.getById(id);
    const ownerId = sandbox?.config?.creatorId;
    { const r = await requirePerm(c, permissionChecker, 'update', 'sandbox', ownerId); if (r) return r; }
    try {
      // eslint-disable-next-line @typescript-eslint/no-restricted-types -- HTTP JSON body: naturally a subset of CreateSandboxInput fields
      const body = await c.req.json<Partial<CreateSandboxInput>>();
      const result = await svc.update(id, body);
      return c.json(ok(result));
    } catch (e: unknown) {
      const { code, status } = errorStatus(e, 'UPDATE_FAILED', 409);
      return c.json(fail(code, e.message), status);
    }
  });

  return router;
}

export const sandboxRouteMeta: RouteMeta[] = [
  { method: 'POST', path: '/pod', description: '从 PodSpec (K8s-aligned) 创建 Pod（持久化 + 状态机）', requestBody: { metadata: { name: 'my-pod' }, spec: { containers: [{ name: 'nginx', image: 'nginx:latest' }] } }, responseDescription: '{ podId, providerId, phase, name }' },
  { method: 'GET', path: '/pod', description: '列出所有 Pod（支持 ?phase=&limit=&cursor=）', responseDescription: '{ items: PodEntity[], nextCursor }' },
  { method: 'GET', path: '/pod/:id', description: '获取 Pod 详情（含 phase + conditions + containers）', responseDescription: 'PodEntity' },
  { method: 'POST', path: '/pod/:id/stop', description: '停止 Pod（phase 转换）', responseDescription: '{ podId, phase }' },
  { method: 'DELETE', path: '/pod/:id', description: '终止并删除 Pod（Terminating → Deleted）', responseDescription: '{ ok: true }' },
  { method: 'POST', path: '/pod/:id/sync', description: '从 provider 同步 Pod 运行状态', responseDescription: 'PodEntity' },
  { method: 'GET', path: '/pod/:id/logs', description: 'Pod 容器日志（?container=name&limitBytes=&sinceSeconds=&timestamps=）', responseDescription: 'ContainerLogResult' },
  { method: 'POST', path: '/pod/:id/exec', description: 'Pod 容器执行命令（返回 WebSocket URI）', requestBody: { cmd: ['/bin/sh'], containerName: 'main' }, responseDescription: '{ execId, webSocketUri }' },
  { method: 'PATCH', path: '/pod/:id', description: '部分更新 PodSpec', requestBody: { spec: { restartPolicy: 'Always' } }, responseDescription: 'PodEntity' },
  { method: 'GET', path: '/', description: '列出所有沙箱（支持 ?status=&limit=&cursor= 过滤）', responseDescription: '{ items: Sandbox[], nextCursor }' },
  { method: 'GET', path: '/:id', description: '获取沙箱详情（含 podPhase 投影）', responseDescription: 'Sandbox' },
  { method: 'POST', path: '/:id/stop', description: '停止沙箱', responseDescription: 'Sandbox' },
  { method: 'POST', path: '/:id/start', description: '启动已停止的沙箱', responseDescription: 'Sandbox' },
  { method: 'DELETE', path: '/:id', description: '终止并删除沙箱', responseDescription: '{ ok: true }' },
  { method: 'POST', path: '/:id/sync', description: '从 provider 同步运行状态', responseDescription: 'ContainerGroupRuntime' },
  { method: 'GET', path: '/:id/health', description: '容器健康状态', responseDescription: 'ContainerHealth[]' },
  { method: 'POST', path: '/:id/restart', description: '重启运行中的沙箱', responseDescription: 'Sandbox' },
  { method: 'PATCH', path: '/:id', description: '更新运行中沙箱规格', responseDescription: 'Sandbox' },
  { method: 'GET', path: '/:id/logs', description: '容器日志流（WebSocket）', responseDescription: 'WebSocket stream' },
];
