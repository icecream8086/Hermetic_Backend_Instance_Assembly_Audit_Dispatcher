import { z } from 'zod';
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { IRunnerService } from './service.ts';
import type { AppContext } from '../../core/deps.ts';
import { CreateRunnerSchema, UpdateRunnerSchema, CreateRunnerGroupSchema, ValidateTokenSchema } from './schema.ts';
import type { RunnerId, RunnerGroupId } from './types.ts';
import { ok } from '../../core/response.ts';
import { OkResponse } from '../../core/http-docs/response-schema.ts';
import {
  RunnerInstanceSchema, RegistrationTokenSchema, RunnerGroupSchema,
  RegisterResultSchema, RunnerListResultSchema, GroupListResultSchema,
  MarkStaleResultSchema, ValidateTokenResultSchema,
} from './response-schema.ts';
import { AppError } from '../../core/types.ts';

function isRoot<E extends { Variables: { currentUser?: { role?: string } } }>(c: Context<E>): void {
  const user = c.var.currentUser;
  if (!user || !['root', 'Operator', 'wheel'].includes(user.role)) {
    throw new AppError(403, 'FORBIDDEN', 'Admin access required');
  }
}

export function createInstancesRouter(svc: IRunnerService): OpenAPIHono<{ Variables: AppContext }> {
  const app = new OpenAPIHono<{ Variables: AppContext }>();

  app.openapi(createRoute({ method: 'post', path: '/', tags: ['instances'], summary: '注册新 Runner', request: { body: { content: { 'application/json': { schema: CreateRunnerSchema } } } }, responses: { 201: { description: '{ runner, token }', content: { 'application/json': { schema: OkResponse(RegisterResultSchema) } } } } }), async (c) => {
    const body = CreateRunnerSchema.parse(await c.req.json());
    const { runner, token } = await svc.register(body);
    return c.json(ok({ runner, token }), 201);
  });

  app.openapi(createRoute({ method: 'get', path: '/', tags: ['instances'], summary: '列出所有 Runner', responses: { 200: { description: '{ items: RunnerInstance[] }', content: { 'application/json': { schema: OkResponse(RunnerListResultSchema) } } } } }), async (c) => {
    const status = c.req.query('status');
    const runners = await svc.list(status);
    return c.json(ok({ items: runners, total: runners.length }));
  });

  app.openapi(createRoute({ method: 'get', path: '/{id}', tags: ['instances'], summary: '获取 Runner 详情', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'RunnerInstance', content: { 'application/json': { schema: OkResponse(RunnerInstanceSchema) } } }, 404: { description: 'Not found' } } }), async (c) => {
    const runner = await svc.get(z.custom<RunnerId>().parse(c.req.param('id')));
    if (!runner) throw new AppError(404, 'RUNNER_NOT_FOUND', 'Runner not found');
    return c.json(ok(runner));
  });

  app.openapi(createRoute({ method: 'put', path: '/{id}', tags: ['instances'], summary: '更新 Runner', request: { params: z.object({ id: z.string() }), body: { content: { 'application/json': { schema: UpdateRunnerSchema } } } }, responses: { 200: { description: 'RunnerInstance', content: { 'application/json': { schema: OkResponse(RunnerInstanceSchema) } } } } }), async (c) => {
    isRoot(c);
    const body = UpdateRunnerSchema.parse(await c.req.json());
    const updated = await svc.update(z.custom<RunnerId>().parse(c.req.param('id')), body, c.var.currentUser?.id);
    return c.json(ok(updated));
  });

  app.openapi(createRoute({ method: 'delete', path: '/{id}', tags: ['instances'], summary: '删除 Runner', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: OkResponse(z.null()) } } } } }), async (c) => {
    isRoot(c);
    await svc.delete(z.custom<RunnerId>().parse(c.req.param('id')), c.var.currentUser?.id);
    return c.json(ok(null));
  });

  app.openapi(createRoute({ method: 'post', path: '/{id}/heartbeat', tags: ['instances'], summary: 'Runner 心跳上报', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'RunnerInstance', content: { 'application/json': { schema: OkResponse(RunnerInstanceSchema) } } } } }), async (c) => {
    const runner = await svc.heartbeat(z.custom<RunnerId>().parse(c.req.param('id')));
    return c.json(ok(runner));
  });

  app.openapi(createRoute({ method: 'post', path: '/mark-stale', tags: ['instances'], summary: '标记超时 Runner 为 offline', responses: { 200: { description: '{ markedOffline: number }', content: { 'application/json': { schema: OkResponse(MarkStaleResultSchema) } } } } }), async (c) => {
    isRoot(c);
    const count = await svc.markStaleOffline();
    return c.json(ok({ markedOffline: count }));
  });

  app.openapi(createRoute({ method: 'post', path: '/registration-token', tags: ['instances'], summary: '创建注册 token', responses: { 201: { description: 'RegistrationToken', content: { 'application/json': { schema: OkResponse(RegistrationTokenSchema) } } } } }), async (c) => {
    isRoot(c);
    const token = await svc.createRegistrationToken();
    return c.json(ok(token), 201);
  });

  app.openapi(createRoute({ method: 'post', path: '/validate-token', tags: ['instances'], summary: '验证并消费注册 token', request: { body: { content: { 'application/json': { schema: ValidateTokenSchema } } } }, responses: { 200: { description: '{ valid: boolean }', content: { 'application/json': { schema: OkResponse(ValidateTokenResultSchema) } } } } }), async (c) => {
    const body = ValidateTokenSchema.parse(await c.req.json());
    const valid = await svc.validateRegistrationToken(body.token);
    return c.json(ok({ valid }));
  });

  app.openapi(createRoute({ method: 'post', path: '/groups', tags: ['instances'], summary: '创建 Runner 组', request: { body: { content: { 'application/json': { schema: CreateRunnerGroupSchema } } } }, responses: { 201: { description: 'RunnerGroup', content: { 'application/json': { schema: OkResponse(RunnerGroupSchema) } } } } }), async (c) => {
    isRoot(c);
    const body = CreateRunnerGroupSchema.parse(await c.req.json());
    const group = await svc.createGroup(body, c.var.currentUser?.id);
    return c.json(ok(group), 201);
  });

  app.openapi(createRoute({ method: 'get', path: '/groups', tags: ['instances'], summary: '列出所有 Runner 组', responses: { 200: { description: '{ items: RunnerGroup[] }', content: { 'application/json': { schema: OkResponse(GroupListResultSchema) } } } } }), async (c) => {
    const groups = await svc.listGroups();
    return c.json(ok({ items: groups, total: groups.length }));
  });

  app.openapi(createRoute({ method: 'get', path: '/groups/{id}', tags: ['instances'], summary: '获取 Runner 组详情', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'RunnerGroup', content: { 'application/json': { schema: OkResponse(RunnerGroupSchema) } } }, 404: { description: 'Not found' } } }), async (c) => {
    const group = await svc.getGroup(z.custom<RunnerGroupId>().parse(c.req.param('id')));
    if (!group) throw new AppError(404, 'RUNNER_GROUP_NOT_FOUND', 'Runner group not found');
    return c.json(ok(group));
  });

  app.openapi(createRoute({ method: 'delete', path: '/groups/{id}', tags: ['instances'], summary: '删除 Runner 组', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: OkResponse(z.null()) } } } } }), async (c) => {
    isRoot(c);
    await svc.deleteGroup(z.custom<RunnerGroupId>().parse(c.req.param('id')), c.var.currentUser?.id);
    return c.json(ok(null));
  });

  return app;
}
