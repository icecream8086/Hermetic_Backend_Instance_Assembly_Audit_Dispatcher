import { Hono } from 'hono';
import type { IContainerSecretService } from './service.ts';
import { CreateContainerSecretSchema, UpdateContainerSecretSchema } from './schema.ts';
import { ok, fail } from '../../core/response.ts';
import type { RouteMeta } from '../../core/http-docs/types.ts';
import { z } from 'zod';
import type { CrudHandlerMap } from '../../core/crud/router.ts';
import { registerCrudRoutes } from '../../core/crud/router.ts';

export function createContainerSecretRouter(svc: IContainerSecretService): Hono<any> {
  const router = new Hono<any>();

  const crud: CrudHandlerMap = {
    create: (r) => r.post('/', async (c) => {
      const secret = await svc.create(CreateContainerSecretSchema.parse(await c.req.json()));
      return c.json(ok(redact(secret)), 201);
    }),

    list: (r) => r.get('/', async (c) => {
      const scopeId = c.req.query('scopeId');
      const items = await svc.list(scopeId);
      return c.json(ok({ items: items.map(redact), total: items.length }));
    }),

    get: (r) => r.get('/:id', async (c) => {
      const secret = await svc.get(c.req.param('id'));
      if (!secret) return c.json(fail('SECRET_NOT_FOUND', 'Container secret not found'), 404);
      return c.json(ok(redact(secret)));
    }),

    update: (r) => r.put('/:id', async (c) => {
      const body: unknown = await c.req.json();
      const secret = await svc.update(c.req.param('id'), UpdateContainerSecretSchema.parse(body));
      return c.json(ok(redact(secret)));
    }),

    delete: (r) => r.delete('/:id', async (c) => {
      await svc.delete(c.req.param('id'));
      return c.json(ok(null));
    }),
  };

  registerCrudRoutes(router, crud);

  // ─── Extra routes (beyond CRUD) ───

  router.post('/:id/upload', async (c) => {
    const body = await c.req.parseBody();
    const file = body.file as File | undefined;
    if (!file) return c.json(fail('VALIDATION_ERROR', 'file is required'), 400);
    const secret = await svc.uploadBlob(
      c.req.param('id'),
      file.name,
      await file.arrayBuffer(),
      file.type,
    );
    return c.json(ok(redact(secret)));
  });

  router.get('/:id/download', async (c) => {
    const data = await svc.resolveData(c.req.param('id'));
    return c.body(data, 200, { 'Content-Type': 'application/octet-stream' });
  });

  router.get('/public-key/:userId', async (c) => {
    const pk = await svc.getPublicKey(c.req.param('userId'));
    if (!pk) return c.json(fail('PUBLIC_KEY_NOT_FOUND', 'No SealedBox keypair for this user. Generate one first.'), 404);
    return c.json(ok({ userId: c.req.param('userId'), publicKey: pk, keyType: 'sealed-box' }));
  });

  router.get('/:id/scopes', async (c) => {
    const secret = await svc.get(c.req.param('id'));
    if (!secret) return c.json(fail('SECRET_NOT_FOUND', 'Container secret not found'), 404);
    return c.json(ok(secret.selectedScopeIds));
  });

  router.put('/:id/scopes', async (c) => {
    const body: unknown = await c.req.json();
    const parsed = z.array(z.string()).safeParse(body);
    if (!parsed.success) {
      return c.json(fail('VALIDATION_ERROR', 'Expected array of scope IDs'), 400);
    }
    const secret = await svc.update(c.req.param('id'), { selectedScopeIds: parsed.data });
    return c.json(ok(redact(secret)));
  });

  router.get('/:id/check-access', async (c) => {
    const scopeId = c.req.query('scopeId');
    if (!scopeId) return c.json(fail('VALIDATION_ERROR', 'scopeId query parameter is required'), 400);
    const allowed = await svc.canAccess(c.req.param('id'), scopeId);
    return c.json(ok({ allowed }));
  });

  return router;
}

function redact(s: any): any {
  if (!s) return s;
  const r = { ...s };
  if (r.value) r.value = '[REDACTED]';
  return r;
}

export const containerSecretRouteMeta: RouteMeta[] = [
  { method: 'POST', path: '/', description: '创建 ContainerSecret（支持 visibility + selectedScopeIds + keyType）', requestBody: { name: 'db-pass', type: 'inline', value: 's3cret!', visibility: 'selected', selectedScopeIds: ['sandbox_1'] }, responseDescription: 'ContainerSecret' },
  { method: 'GET', path: '/', description: '列出 ContainerSecret（?scopeId= 按可见性过滤）', responseDescription: '{ items: ContainerSecret[] }' },
  { method: 'GET', path: '/:id', description: '获取 ContainerSecret 详情', responseDescription: 'ContainerSecret' },
  { method: 'PUT', path: '/:id', description: '更新 ContainerSecret（version 自增）', responseDescription: 'ContainerSecret' },
  { method: 'DELETE', path: '/:id', description: '删除 ContainerSecret', responseDescription: '{ ok: true }' },
  { method: 'POST', path: '/:id/upload', description: '上传文件到 upload 类型 secret', responseDescription: 'ContainerSecret' },
  { method: 'GET', path: '/:id/download', description: '下载 upload 类型 secret 的内容', responseDescription: 'binary' },
  { method: 'GET', path: '/:id/scopes', description: '获取 secret 的 selectedScopeIds', responseDescription: 'string[]' },
  { method: 'PUT', path: '/:id/scopes', description: '设置 secret 的 selectedScopeIds', requestBody: ['scope_1', 'scope_2'], responseDescription: 'ContainerSecret' },
  { method: 'GET', path: '/:id/check-access', description: '检查 scopeId 是否有权访问此 secret（?scopeId=）', responseDescription: '{ allowed: boolean }' },
  { method: 'GET', path: '/public-key/:userId', description: '获取用户的 SealedBox 公钥（用于客户端侧加密 secret）', responseDescription: '{ userId, publicKey, keyType }' },
];
