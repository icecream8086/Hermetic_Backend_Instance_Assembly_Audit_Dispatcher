import { z } from 'zod';
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { ISandboxService } from './interfaces.ts';
import { createSandboxId, type SandboxStatus } from './types.ts';
import type { CreateSandboxInput } from './types.ts';
import type { PodSpec } from '../../core/pod/types.ts';
import { createPodId, type PodPhase } from '../../core/pod/types.ts';
import type { PodService } from '../../core/pod/service.ts';
import type { IProviderRegistry } from '../../core/provider/interfaces.ts';
import type { AppContext } from '../../core/deps.ts';
import { ok } from '../../core/response.ts';
import { OkResponse } from '../../core/http-docs/response-schema.ts';
import { AppError } from '../../core/types.ts';

interface PermissionCheckFn { check(params: { userId: string; action: string; resource: string; ip?: string }): Promise<{ allowed: boolean; reason: string }> }

interface SandboxEnv { Variables: AppContext }

async function requirePerm(c: Context<SandboxEnv>, checker: PermissionCheckFn | undefined, action: string, resource: string, resourceOwnerId?: string): Promise<void> {
  if (!checker) return;
  const user = c.var.currentUser;
  if (!user) return;
  const result = await checker.check({ userId: user.id, action, resource, ...(resourceOwnerId ? { resourceOwnerId } : {}) });
  if (!result.allowed) throw new AppError(403, 'FORBIDDEN', result.reason);
}

function notConfigured(): never {
  throw new AppError(501, 'NOT_CONFIGURED', 'PodService not available');
}

export function createSandboxRouter(
  svc: ISandboxService,
  _providers: IProviderRegistry,
  permissionChecker?: PermissionCheckFn,
  podService?: PodService,
): OpenAPIHono<{ Variables: AppContext }> {
  const app = new OpenAPIHono<{ Variables: AppContext }>();

  // ─── Pod API ───

  app.openapi(createRoute({ method: 'post', path: '/pod', tags: ['sandboxes'], summary: '从 PodSpec 创建 Pod', responses: { 201: { description: 'Pod created', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    await requirePerm(c, permissionChecker, 'create', 'pod');
    if (!podService) notConfigured();
    const spec = await c.req.json<PodSpec>();
    if (!spec.metadata.name || !spec.spec.containers.length) throw new AppError(400, 'VALIDATION_ERROR', 'PodSpec requires metadata.name and spec.containers');
    const pod = await podService.provision(spec, { creatorId: c.var.currentUser?.id });
    return c.json(ok({ podId: pod.podId, providerId: pod.providerId, phase: pod.phase, name: pod.name }), 201);
  });

  app.openapi(createRoute({ method: 'get', path: '/pod', tags: ['sandboxes'], summary: '列出所有 Pod', responses: { 200: { description: '{ items, nextCursor }', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    await requirePerm(c, permissionChecker, 'read', 'pod');
    if (!podService) notConfigured();
    const phase = (c.req.query('phase') || undefined) as PodPhase | undefined;
    const limit = parseInt(c.req.query('limit') ?? '50');
    const cursor = c.req.query('cursor');
    const result = await podService.list(phase, limit, cursor);
    return c.json(ok(result));
  });

  app.openapi(createRoute({ method: 'get', path: '/pod/{id}', tags: ['sandboxes'], summary: '获取 Pod 详情', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'PodEntity', content: { 'application/json': { schema: OkResponse(z.unknown()) } } }, 404: { description: 'Not found' } } }), async (c) => {
    if (!podService) notConfigured();
    const podId = createPodId(c.req.param('id'));
    const pod = await podService.getById(podId);
    await requirePerm(c, permissionChecker, 'read', 'pod', pod.creatorId);
    if (!pod) throw new AppError(404, 'POD_NOT_FOUND', 'Pod not found');
    return c.json(ok(pod));
  });

  app.openapi(createRoute({ method: 'post', path: '/pod/{id}/stop', tags: ['sandboxes'], summary: '停止 Pod', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: '{ podId, phase }', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    if (!podService) notConfigured();
    const podId = createPodId(c.req.param('id'));
    const pod = await podService.getById(podId);
    await requirePerm(c, permissionChecker, 'update', 'pod', pod.creatorId);
    const stopped = await podService.stop(podId);
    return c.json(ok({ podId: stopped.podId, phase: stopped.phase }));
  });

  app.openapi(createRoute({ method: 'delete', path: '/pod/{id}', tags: ['sandboxes'], summary: '终止 Pod', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    if (!podService) notConfigured();
    const podId = createPodId(c.req.param('id'));
    const pod = await podService.getById(podId);
    await requirePerm(c, permissionChecker, 'delete', 'pod', pod.creatorId);
    await podService.terminate(podId);
    return c.json(ok(null));
  });

  app.openapi(createRoute({ method: 'post', path: '/pod/{id}/sync', tags: ['sandboxes'], summary: '同步 Pod 运行状态', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'PodEntity', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    if (!podService) notConfigured();
    const podId = createPodId(c.req.param('id'));
    const pod = await podService.getById(podId);
    await requirePerm(c, permissionChecker, 'update', 'pod', pod.creatorId);
    const synced = await podService.syncRuntime(podId);
    return c.json(ok(synced));
  });

  // ─── Pod API: lifecycle extensions (start / restart / health) ───

  app.openapi(createRoute({ method: 'post', path: '/pod/{id}/start', tags: ['sandboxes'], summary: '启动 Pod', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: '{ podId, phase }', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    if (!podService) notConfigured();
    const podId = createPodId(c.req.param('id'));
    const pod = await podService.getById(podId);
    await requirePerm(c, permissionChecker, 'update', 'pod', pod.creatorId);
    const started = await podService.start(podId);
    return c.json(ok({ podId: started.podId, phase: started.phase }));
  });

  app.openapi(createRoute({ method: 'post', path: '/pod/{id}/restart', tags: ['sandboxes'], summary: '重启 Pod', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: '{ podId, phase }', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    if (!podService) notConfigured();
    const podId = createPodId(c.req.param('id'));
    const pod = await podService.getById(podId);
    await requirePerm(c, permissionChecker, 'update', 'pod', pod.creatorId);
    const restarted = await podService.restart(podId);
    return c.json(ok({ podId: restarted.podId, phase: restarted.phase }));
  });

  app.openapi(createRoute({ method: 'get', path: '/pod/{id}/health', tags: ['sandboxes'], summary: 'Pod 容器健康状态', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'PodHealth[]', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    if (!podService) notConfigured();
    const podId = createPodId(c.req.param('id'));
    const pod = await podService.getById(podId);
    await requirePerm(c, permissionChecker, 'read', 'pod', pod.creatorId);
    const health = await podService.getHealth(podId);
    return c.json(ok(health));
  });

  app.openapi(createRoute({ method: 'get', path: '/pod/{id}/logs', tags: ['sandboxes'], summary: 'Pod 容器日志', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'ContainerLogResult', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    if (!podService) notConfigured();
    const podId = createPodId(c.req.param('id'));
    const pod = await podService.getById(podId);
    await requirePerm(c, permissionChecker, 'read', 'pod', pod.creatorId);
    const containerName = c.req.query('container') ?? '';
    if (!containerName) throw new AppError(400, 'VALIDATION_ERROR', 'Query parameter "container" is required');
    const options: Record<string, unknown> = {};
    const lb = c.req.query('limitBytes'); if (lb) options.limitBytes = parseInt(lb);
    const ss = c.req.query('sinceSeconds'); if (ss) options.sinceSeconds = parseInt(ss);
    if (c.req.query('timestamps') === 'true') options.timestamps = true;
    const result = await podService.getLogs(podId, containerName, options);
    return c.json(ok(result));
  });

  app.openapi(createRoute({ method: 'post', path: '/pod/{id}/exec', tags: ['sandboxes'], summary: 'Pod 容器执行命令', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Exec result', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    if (!podService) notConfigured();
    const podId = createPodId(c.req.param('id'));
    const pod = await podService.getById(podId);
    await requirePerm(c, permissionChecker, 'update', 'pod', pod.creatorId);
    const body = await c.req.json<{ cmd: string[]; containerName?: string }>();
    if (!body.cmd.length) throw new AppError(400, 'VALIDATION_ERROR', 'Body.cmd (string array) is required');
    const result = await podService.exec(podId, body.cmd, body.containerName);
    return c.json(ok(result));
  });

  app.openapi(createRoute({ method: 'patch', path: '/pod/{id}', tags: ['sandboxes'], summary: '部分更新 PodSpec', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'PodEntity', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    if (!podService) notConfigured();
    const podId = createPodId(c.req.param('id'));
    const pod = await podService.getById(podId);
    await requirePerm(c, permissionChecker, 'update', 'pod', pod.creatorId);
    const specPatch = await c.req.json<Partial<PodSpec>>();
    const updated = await podService.update(podId, specPatch);
    return c.json(ok(updated));
  });

  // ─── Sandbox API ───

  app.openapi(createRoute({ method: 'get', path: '/', tags: ['sandboxes'], summary: '列出所有沙箱', responses: { 200: { description: '{ items, nextCursor }', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    await requirePerm(c, permissionChecker, 'read', 'sandbox');
    const status = (c.req.query('status') || undefined) as SandboxStatus | undefined;
    const apiVer = c.req.query('apiVersion');
    const podPhase = c.req.query('podPhase') || undefined;
    const limit = parseInt(c.req.query('limit') ?? '50');
    const cursor = c.req.query('cursor');
    let result = await svc.list?.(status, limit, cursor) ?? { items: [] };
    if (apiVer) result = { ...result, items: result.items.filter(s => s.config.apiVersion === apiVer) };
    else result = { ...result, items: result.items.filter(s => s.config.apiVersion !== 'hbi-aad/v2') };
    if (podService && result.items.length > 0) {
      const enriched = await Promise.all(result.items.map(async s => {
        const podUid = (s as unknown as Record<string, unknown>).podUid as string | undefined;
        if (!podUid) return { ...s, podPhase: null };
        try { const pod = await podService.getById(createPodId(podUid)); return { ...s, podPhase: pod?.phase ?? null }; }
        catch { return { ...s, podPhase: null }; }
      }));
      if (podPhase) result = { ...result, items: enriched.filter(s => (s as Record<string, unknown>).podPhase === podPhase) };
      else result = { ...result, items: enriched };
    }
    return c.json(ok(result));
  });

  app.openapi(createRoute({ method: 'get', path: '/{id}', tags: ['sandboxes'], summary: '获取沙箱详情', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Sandbox', content: { 'application/json': { schema: OkResponse(z.unknown()) } } }, 404: { description: 'Not found' } } }), async (c) => {
    const id = createSandboxId(c.req.param('id'));
    const sandbox = await svc.getById(id);
    await requirePerm(c, permissionChecker, 'read', 'sandbox', sandbox.config.creatorId);
    if (!sandbox) throw new AppError(404, 'SANDBOX_NOT_FOUND', 'Sandbox not found');
    let podPhase: string | null = null;
    if (podService) {
      const podUid = (sandbox as unknown as Record<string, unknown>).podUid as string | undefined;
      if (podUid) { try { const pod = await podService.getById(createPodId(podUid)); podPhase = pod?.phase ?? null; } catch { podPhase = null; } }
    }
    return c.json(ok({ ...sandbox, podPhase }));
  });

  app.openapi(createRoute({ method: 'post', path: '/{id}/stop', tags: ['sandboxes'], summary: '停止沙箱', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Sandbox', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    const id = createSandboxId(c.req.param('id'));
    const sandbox = await svc.getById(id);
    await requirePerm(c, permissionChecker, 'update', 'sandbox', sandbox.config.creatorId);
    const stopped = await svc.stop(id);
    return c.json(ok(stopped));
  });

  app.openapi(createRoute({ method: 'post', path: '/{id}/start', tags: ['sandboxes'], summary: '启动沙箱', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Sandbox', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    const id = createSandboxId(c.req.param('id'));
    const sandbox = await svc.getById(id);
    await requirePerm(c, permissionChecker, 'update', 'sandbox', sandbox.config.creatorId);
    if (!svc.start) throw new AppError(501, 'START_FAILED', 'Start not supported by this service');
    const started = await svc.start(id);
    return c.json(ok(started));
  });

  app.openapi(createRoute({ method: 'delete', path: '/{id}', tags: ['sandboxes'], summary: '删除沙箱', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    const id = createSandboxId(c.req.param('id'));
    const sandbox = await svc.getById(id);
    await requirePerm(c, permissionChecker, 'delete', 'sandbox', sandbox.config.creatorId);
    await svc.terminate(id, c.var.currentUser?.id);
    return c.json(ok(null));
  });

  app.openapi(createRoute({ method: 'post', path: '/{id}/sync', tags: ['sandboxes'], summary: '同步沙箱状态', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Sync result', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    const id = createSandboxId(c.req.param('id'));
    const sandbox = await svc.getById(id);
    await requirePerm(c, permissionChecker, 'update', 'sandbox', sandbox.config.creatorId);
    const runtime = await svc.syncRuntime(id);
    const updated = await svc.getById(id);
    return c.json(ok({ runtime, sandbox: updated }));
  });

  app.openapi(createRoute({ method: 'get', path: '/{id}/health', tags: ['sandboxes'], summary: '容器健康状态', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'ContainerHealth[]', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    const id = createSandboxId(c.req.param('id'));
    const sandbox = await svc.getById(id);
    await requirePerm(c, permissionChecker, 'read', 'sandbox', sandbox.config.creatorId);
    const health = await svc.getHealth(id);
    return c.json(ok(health));
  });

  app.openapi(createRoute({ method: 'post', path: '/{id}/restart', tags: ['sandboxes'], summary: '重启沙箱', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Sandbox', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    const id = createSandboxId(c.req.param('id'));
    const sandbox = await svc.getById(id);
    await requirePerm(c, permissionChecker, 'update', 'sandbox', sandbox.config.creatorId);
    const result = await svc.restart(id);
    return c.json(ok(result));
  });

  app.openapi(createRoute({ method: 'patch', path: '/{id}', tags: ['sandboxes'], summary: '更新沙箱规格', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Sandbox', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    const id = createSandboxId(c.req.param('id'));
    const sandbox = await svc.getById(id);
    await requirePerm(c, permissionChecker, 'update', 'sandbox', sandbox.config.creatorId);
    const body = await c.req.json<Partial<CreateSandboxInput>>();
    const result = await svc.update(id, body);
    return c.json(ok(result));
  });

  return app;
}
