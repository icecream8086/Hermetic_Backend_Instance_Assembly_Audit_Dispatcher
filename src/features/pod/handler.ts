import { z } from 'zod';
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { createPodId } from '../../core/pod/types.ts';
import type { PodService } from '../../core/pod/service.ts';
import type { AppContext } from '../../core/deps.ts';
import { ok } from '../../core/response.ts';
import { OkResponse } from '../../core/http-docs/response-schema.ts';
import { PodSpecSchema, PodSpecPatchSchema } from '../../core/pod/schema.ts';
import {
  PodCreateResponseSchema,
  PodPhaseChangeResponseSchema,
  PodHealthSchema,
  PodExecResponseSchema,
  ContainerLogResultSchema,
  PodEntitySchema,
  PodListResponseSchema,
  PodPhaseSchema,
} from './response-schema.ts';
import { AppError } from '../../core/types.ts';

interface PermissionCheckFn { check(params: { userId: string; action: string; resource: string; ip?: string }): Promise<{ allowed: boolean; reason: string }> }

interface PodEnv { Variables: AppContext }

async function requirePerm(c: Context<PodEnv>, checker: PermissionCheckFn | undefined, action: string, resource: string, resourceOwnerId?: string): Promise<void> {
  if (!checker) return;
  const user = c.var.currentUser;
  if (!user) return;
  const result = await checker.check({ userId: user.id, action, resource, ...(resourceOwnerId ? { resourceOwnerId } : {}) });
  if (!result.allowed) throw new AppError(403, 'FORBIDDEN', result.reason);
}

export function createPodRouter(
  permissionChecker: PermissionCheckFn | undefined,
  podService: PodService,
): OpenAPIHono<{ Variables: AppContext }> {
  const app = new OpenAPIHono<{ Variables: AppContext }>();

  // ─── Pod CRUD ───

  app.openapi(createRoute({ method: 'post', path: '/', tags: ['pods'], summary: '从 PodSpec 创建 Pod', responses: { 201: { description: 'Pod created', content: { 'application/json': { schema: OkResponse(PodCreateResponseSchema) } } } } }), async (c) => {
    await requirePerm(c, permissionChecker, 'create', 'pod');
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Zod schema validates at runtime; cast to known interface
    const spec = PodSpecSchema.parse(await c.req.json()) as import('../../core/pod/types.ts').PodSpec;
    const pod = await podService.provision(spec, { creatorId: c.var.currentUser?.id });
    return c.json(ok({ podId: pod.podId, providerId: pod.providerId, phase: pod.phase, name: pod.name }), 201);
  });

  app.openapi(createRoute({ method: 'get', path: '/', tags: ['pods'], summary: '列出所有 Pod', responses: { 200: { description: '{ items, nextCursor }', content: { 'application/json': { schema: OkResponse(PodListResponseSchema) } } } } }), async (c) => {
    await requirePerm(c, permissionChecker, 'read', 'pod');
    const phase = PodPhaseSchema.optional().parse(c.req.query('phase') || undefined);
    const limit = parseInt(c.req.query('limit') ?? '50');
    const cursor = c.req.query('cursor');
    const result = await podService.list(phase, limit, cursor);
    return c.json(ok(result));
  });

  app.openapi(createRoute({ method: 'get', path: '/{id}', tags: ['pods'], summary: '获取 Pod 详情', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'PodEntity', content: { 'application/json': { schema: OkResponse(PodEntitySchema) } } }, 404: { description: 'Not found' } } }), async (c) => {
    const podId = createPodId(c.req.param('id'));
    const pod = await podService.getById(podId);
    if (!pod) throw new AppError(404, 'POD_NOT_FOUND', 'Pod not found');
    await requirePerm(c, permissionChecker, 'read', 'pod', pod.creatorId);
    return c.json(ok(pod));
  });

  app.openapi(createRoute({ method: 'post', path: '/{id}/stop', tags: ['pods'], summary: '停止 Pod', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: '{ podId, phase }', content: { 'application/json': { schema: OkResponse(PodPhaseChangeResponseSchema) } } } } }), async (c) => {
    const podId = createPodId(c.req.param('id'));
    const pod = await podService.getById(podId);
    if (!pod) throw new AppError(404, 'POD_NOT_FOUND', 'Pod not found');
    await requirePerm(c, permissionChecker, 'update', 'pod', pod.creatorId);
    const stopped = await podService.stop(podId);
    return c.json(ok({ podId: stopped.podId, phase: stopped.phase }));
  });

  app.openapi(createRoute({ method: 'delete', path: '/{id}', tags: ['pods'], summary: '终止 Pod', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: OkResponse(z.null()) } } } } }), async (c) => {
    const podId = createPodId(c.req.param('id'));
    const pod = await podService.getById(podId);
    if (!pod) throw new AppError(404, 'POD_NOT_FOUND', 'Pod not found');
    await requirePerm(c, permissionChecker, 'delete', 'pod', pod.creatorId);
    await podService.terminate(podId);
    return c.json(ok(null));
  });

  app.openapi(createRoute({ method: 'post', path: '/{id}/sync', tags: ['pods'], summary: '同步 Pod 运行状态', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'PodEntity', content: { 'application/json': { schema: OkResponse(PodEntitySchema) } } } } }), async (c) => {
    const podId = createPodId(c.req.param('id'));
    const pod = await podService.getById(podId);
    if (!pod) throw new AppError(404, 'POD_NOT_FOUND', 'Pod not found');
    await requirePerm(c, permissionChecker, 'update', 'pod', pod.creatorId);
    const synced = await podService.syncRuntime(podId);
    return c.json(ok(synced));
  });

  // ─── Pod lifecycle extensions (start / restart / health) ───

  app.openapi(createRoute({ method: 'post', path: '/{id}/start', tags: ['pods'], summary: '启动 Pod', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: '{ podId, phase }', content: { 'application/json': { schema: OkResponse(PodPhaseChangeResponseSchema) } } } } }), async (c) => {
    const podId = createPodId(c.req.param('id'));
    const pod = await podService.getById(podId);
    if (!pod) throw new AppError(404, 'POD_NOT_FOUND', 'Pod not found');
    await requirePerm(c, permissionChecker, 'update', 'pod', pod.creatorId);
    const started = await podService.start(podId);
    return c.json(ok({ podId: started.podId, phase: started.phase }));
  });

  app.openapi(createRoute({ method: 'post', path: '/{id}/restart', tags: ['pods'], summary: '重启 Pod', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: '{ podId, phase }', content: { 'application/json': { schema: OkResponse(PodPhaseChangeResponseSchema) } } } } }), async (c) => {
    const podId = createPodId(c.req.param('id'));
    const pod = await podService.getById(podId);
    if (!pod) throw new AppError(404, 'POD_NOT_FOUND', 'Pod not found');
    await requirePerm(c, permissionChecker, 'update', 'pod', pod.creatorId);
    const restarted = await podService.restart(podId);
    return c.json(ok({ podId: restarted.podId, phase: restarted.phase }));
  });

  app.openapi(createRoute({ method: 'get', path: '/{id}/health', tags: ['pods'], summary: 'Pod 容器健康状态', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'PodHealth[]', content: { 'application/json': { schema: OkResponse(z.array(PodHealthSchema).readonly()) } } } } }), async (c) => {
    const podId = createPodId(c.req.param('id'));
    const pod = await podService.getById(podId);
    if (!pod) throw new AppError(404, 'POD_NOT_FOUND', 'Pod not found');
    await requirePerm(c, permissionChecker, 'read', 'pod', pod.creatorId);
    const health = await podService.getHealth(podId);
    return c.json(ok(health));
  });

  app.openapi(createRoute({ method: 'get', path: '/{id}/logs', tags: ['pods'], summary: 'Pod 容器日志', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'ContainerLogResult', content: { 'application/json': { schema: OkResponse(ContainerLogResultSchema) } } } } }), async (c) => {
    const podId = createPodId(c.req.param('id'));
    const pod = await podService.getById(podId);
    if (!pod) throw new AppError(404, 'POD_NOT_FOUND', 'Pod not found');
    await requirePerm(c, permissionChecker, 'read', 'pod', pod.creatorId);
    const containerName = c.req.query('container') ?? '';
    if (!containerName) throw new AppError(400, 'VALIDATION_ERROR', 'Query parameter "container" is required');
    const options: { limitBytes?: number; sinceSeconds?: number; timestamps?: boolean } = {};
    const lb = c.req.query('limitBytes'); if (lb) options.limitBytes = parseInt(lb);
    const ss = c.req.query('sinceSeconds'); if (ss) options.sinceSeconds = parseInt(ss);
    if (c.req.query('timestamps') === 'true') options.timestamps = true;
    const result = await podService.getLogs(podId, containerName, options);
    return c.json(ok(result));
  });

  app.openapi(createRoute({ method: 'post', path: '/{id}/exec', tags: ['pods'], summary: 'Pod 容器执行命令', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Exec result', content: { 'application/json': { schema: OkResponse(PodExecResponseSchema) } } } } }), async (c) => {
    const podId = createPodId(c.req.param('id'));
    const pod = await podService.getById(podId);
    if (!pod) throw new AppError(404, 'POD_NOT_FOUND', 'Pod not found');
    await requirePerm(c, permissionChecker, 'update', 'pod', pod.creatorId);
    const body = z.object({
      cmd: z.array(z.string()),
      containerName: z.string().optional(),
    }).parse(await c.req.json());
    if (body.cmd.length === 0) throw new AppError(400, 'VALIDATION_ERROR', 'Body.cmd (string array) is required');
    const result = await podService.exec(podId, body.cmd, body.containerName);
    return c.json(ok(result));
  });

  app.openapi(createRoute({ method: 'patch', path: '/{id}', tags: ['pods'], summary: '部分更新 PodSpec', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'PodEntity', content: { 'application/json': { schema: OkResponse(PodEntitySchema) } } } } }), async (c) => {
    const podId = createPodId(c.req.param('id'));
    const pod = await podService.getById(podId);
    if (!pod) throw new AppError(404, 'POD_NOT_FOUND', 'Pod not found');
    await requirePerm(c, permissionChecker, 'update', 'pod', pod.creatorId);
    const specPatch = PodSpecPatchSchema.parse(await c.req.json());
    const updated = await podService.update(podId, specPatch);
    return c.json(ok(updated));
  });

  return app;
}
