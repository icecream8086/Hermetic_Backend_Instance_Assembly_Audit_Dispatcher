import { z } from 'zod';
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { IContainerSecretService } from './service.ts';
import { CreateContainerSecretSchema, UpdateContainerSecretSchema } from './schema.ts';
import { AppError } from '../../core/types.ts';
import { ok } from '../../core/response.ts';
import { OkResponse } from '../../core/http-docs/response-schema.ts';

export function createContainerSecretRouter(svc: IContainerSecretService): OpenAPIHono {
  const app = new OpenAPIHono();

  app.openapi(createRoute({ method: 'post', path: '/', tags: ['container-secrets'], summary: '创建 ContainerSecret', request: { body: { content: { 'application/json': { schema: CreateContainerSecretSchema } } } }, responses: { 201: { description: 'ContainerSecret', content: { 'application/json': { schema: OkResponse(z.unknown()) } } }, 400: { description: 'Bad request', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    const secret = await svc.create(await CreateContainerSecretSchema.parse(c.req.json()));
    return c.json(ok(redact(secret)), 201);
  });

  app.openapi(createRoute({ method: 'get', path: '/', tags: ['container-secrets'], summary: '列出 ContainerSecret', responses: { 200: { description: '{ items: ContainerSecret[] }', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    const scopeId = c.req.query('scopeId');
    const items = await svc.list(scopeId);
    return c.json(ok({ items: items.map(redact), total: items.length }));
  });

  app.openapi(createRoute({ method: 'get', path: '/{id}', tags: ['container-secrets'], summary: '获取 ContainerSecret 详情', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'ContainerSecret', content: { 'application/json': { schema: OkResponse(z.unknown()) } } }, 404: { description: 'Not found', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    const secret = await svc.get(c.req.param('id'));
    if (!secret) throw new AppError(404, 'SECRET_NOT_FOUND', 'Container secret not found');
    return c.json(ok(redact(secret)));
  });

  app.openapi(createRoute({ method: 'put', path: '/{id}', tags: ['container-secrets'], summary: '更新 ContainerSecret', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'ContainerSecret', content: { 'application/json': { schema: OkResponse(z.unknown()) } } }, 404: { description: 'Not found', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    const body = await z.unknown().parse(c.req.json());
    const secret = await svc.update(c.req.param('id'), UpdateContainerSecretSchema.parse(body));
    return c.json(ok(redact(secret)));
  });

  app.openapi(createRoute({ method: 'delete', path: '/{id}', tags: ['container-secrets'], summary: '删除 ContainerSecret', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    await svc.delete(c.req.param('id'));
    return c.json(ok(null));
  });

  app.openapi(createRoute({ method: 'post', path: '/{id}/upload', tags: ['container-secrets'], summary: '上传文件到 upload 类型 secret', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'ContainerSecret', content: { 'application/json': { schema: OkResponse(z.unknown()) } } }, 404: { description: 'Not found', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    const body = await c.req.parseBody();
    const file = body.file as File | undefined;
    if (!file) throw new AppError(400, 'VALIDATION_ERROR', 'file is required');
    const secret = await svc.uploadBlob(c.req.param('id'), file.name, await file.arrayBuffer(), file.type);
    return c.json(ok(redact(secret)));
  });

  app.openapi(createRoute({ method: 'get', path: '/{id}/download', tags: ['container-secrets'], summary: '下载 upload 类型 secret 的内容', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'binary' }, 404: { description: 'Not found' } } }), async (c) => {
    const data = await svc.resolveData(c.req.param('id'));
    return c.body(data, 200, { 'Content-Type': 'application/octet-stream' });
  });

  app.openapi(createRoute({ method: 'get', path: '/public-key/{userId}', tags: ['container-secrets'], summary: '获取用户的 SealedBox 公钥', request: { params: z.object({ userId: z.string() }) }, responses: { 200: { description: '{ userId, publicKey, keyType }', content: { 'application/json': { schema: OkResponse(z.unknown()) } } }, 404: { description: 'Not found', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    const pk = await svc.getPublicKey(c.req.param('userId'));
    if (!pk) throw new AppError(404, 'PUBLIC_KEY_NOT_FOUND', 'No SealedBox keypair for this user. Generate one first.');
    return c.json(ok({ userId: c.req.param('userId'), publicKey: pk, keyType: 'sealed-box' }));
  });

  app.openapi(createRoute({ method: 'get', path: '/{id}/scopes', tags: ['container-secrets'], summary: '获取 secret 的 selectedScopeIds', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'string[]', content: { 'application/json': { schema: OkResponse(z.unknown()) } } }, 404: { description: 'Not found', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    const secret = await svc.get(c.req.param('id'));
    if (!secret) throw new AppError(404, 'SECRET_NOT_FOUND', 'Container secret not found');
    return c.json(ok(secret.selectedScopeIds));
  });

  app.openapi(createRoute({ method: 'put', path: '/{id}/scopes', tags: ['container-secrets'], summary: '设置 secret 的 selectedScopeIds', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'ContainerSecret', content: { 'application/json': { schema: OkResponse(z.unknown()) } } }, 404: { description: 'Not found', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    const body = await z.unknown().parse(c.req.json());
    const parsed = z.array(z.string()).parse(body);
    const secret = await svc.update(c.req.param('id'), { selectedScopeIds: parsed });
    return c.json(ok(redact(secret)));
  });

  app.openapi(createRoute({ method: 'get', path: '/{id}/check-access', tags: ['container-secrets'], summary: '检查 scopeId 是否有权访问此 secret', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: '{ allowed: boolean }', content: { 'application/json': { schema: OkResponse(z.unknown()) } } }, 400: { description: 'Bad request', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    const scopeId = c.req.query('scopeId');
    if (!scopeId) throw new AppError(400, 'VALIDATION_ERROR', 'scopeId query parameter is required');
    const allowed = await svc.canAccess(c.req.param('id'), scopeId);
    return c.json(ok({ allowed }));
  });

  return app;
}

function redact(s: any): any {
  if (!s) return s;
  const r = { ...s };
  if (r.value) r.value = '[REDACTED]';
  return r;
}
