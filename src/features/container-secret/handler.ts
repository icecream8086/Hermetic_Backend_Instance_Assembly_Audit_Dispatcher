import { Hono } from 'hono';
import type { IContainerSecretService } from './service.ts';
import { CreateContainerSecretSchema, UpdateContainerSecretSchema } from './schema.ts';
import { ok, fail } from '../../core/response.ts';
import type { RouteMeta } from '../../core/http-docs/types.ts';

export function createContainerSecretRouter(svc: IContainerSecretService): Hono<any> {
  const router = new Hono<any>();

  // ─── Create (inline) ───
  router.post('/', async (c) => {
    const body: unknown = await c.req.json();
    const parsed = CreateContainerSecretSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    }
    const secret = await svc.create(parsed.data as any);
    return c.json(ok(redact(secret)), 201);
  });

  // ─── List ───
  router.get('/', async (c) => {
    const items = await svc.list();
    return c.json(ok({ items: items.map(redact), total: items.length }));
  });

  // ─── Get ───
  router.get('/:id', async (c) => {
    const secret = await svc.get(c.req.param('id'));
    if (!secret) return c.json(fail('SECRET_NOT_FOUND', 'Container secret not found'), 404);
    return c.json(ok(redact(secret)));
  });

  // ─── Update ───
  router.put('/:id', async (c) => {
    const body: unknown = await c.req.json();
    const parsed = UpdateContainerSecretSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    }
    const secret = await svc.update(c.req.param('id'), parsed.data as any);
    return c.json(ok(redact(secret)));
  });

  // ─── Delete ───
  router.delete('/:id', async (c) => {
    await svc.delete(c.req.param('id'));
    return c.json(ok(null));
  });

  // ─── Upload blob (multipart) ───
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

  // ─── Download blob ───
  router.get('/:id/download', async (c) => {
    const data = await svc.resolveData(c.req.param('id'));
    return c.body(data, 200, { 'Content-Type': 'application/octet-stream' });
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
  { method: 'POST', path: '/', description: '创建 ContainerSecret（inline 需要 value，upload 后续调用 upload）', requestBody: { name: 'db-pass', type: 'inline', value: 's3cret!' }, responseDescription: 'ContainerSecret' },
  { method: 'GET', path: '/', description: '列出所有 ContainerSecret（value 显示 [REDACTED]）', responseDescription: '{ items: ContainerSecret[] }' },
  { method: 'GET', path: '/:id', description: '获取 ContainerSecret 详情', responseDescription: 'ContainerSecret' },
  { method: 'PUT', path: '/:id', description: '更新 ContainerSecret 元数据或值', responseDescription: 'ContainerSecret' },
  { method: 'DELETE', path: '/:id', description: '删除 ContainerSecret', responseDescription: '{ ok: true }' },
  { method: 'POST', path: '/:id/upload', description: '上传文件到 upload 类型 secret（multipart/form-data, field: file）', responseDescription: 'ContainerSecret' },
  { method: 'GET', path: '/:id/download', description: '下载 upload 类型 secret 的内容', responseDescription: 'binary' },
];
