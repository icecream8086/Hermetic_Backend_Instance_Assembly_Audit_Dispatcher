import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import type { Context } from 'hono';
import type { BucketService, InstanceService, ImageRepositoryService } from '../../core/region/index.ts';
import { createInstanceId } from '../../core/region/index.ts';
import type { CreateImageInput } from '../../core/region/image.ts';
import { AlibabaRegion, AwsRegion, PodmanRegion } from '../../core/region/types.ts';
import type { AppContext } from '../../core/deps.ts';
import { ok } from '../../core/response.ts';
import { OkResponse } from '../../core/http-docs/response-schema.ts';
import {
  ComputeInstanceSchema,
  RegionBucketSchema,
  MaskedCredentialSchema,
  ImageRepositorySchema,
  S3PolicySchema,
  PullTaskSchema,
  S3MultipartUploadSessionSchema,
  S3MultipartDownloadSessionSchema,
  S3MultipartCompleteResultSchema,
  S3ListPartsResultSchema,
} from './response-schema.ts';
import { AppError } from '../../core/types.ts';
import type { CreateBucketBody, CreateInstanceBody, HeartbeatBody, CreateCredentialBody } from './types.ts';
import type { CredentialService } from '../../core/auth/credential.ts';
import { toMasked } from '../../core/auth/credential.ts';
import type { S3PolicyManager } from '../../core/s3-policy/manager.ts';
import type { CreateS3PolicyInput, UpdateS3PolicyInput } from '../../core/s3-policy/types.ts';
import type { IS3Provider } from '../../core/provider/s3.ts';
import type { S3MultipartUploadSession, S3MultipartDownloadSession } from '../../core/provider/s3-types.ts';

function isRoot<E extends { Variables: { currentUser?: { role?: string } } }>(c: Context<E>): void {
  const user = c.var.currentUser;
  if (!user || !['root', 'Operator', 'wheel'].includes(user.role)) {
    throw new AppError(403, 'FORBIDDEN', 'Admin access required');
  }
}

/** Extract filter params from query string. */
function extractFilter(c: any): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of ['region', 'platform', 'status']) { const v = c.req.query(key); if (v) out[key] = v; }
  return out;
}

/** Register CRUD routes on an OpenAPIHono sub-app. */
function mkTopoCrud<T, TC = unknown, TU = unknown>(
  app: OpenAPIHono<{ Variables: AppContext }>,
  svc: { create(input: TC): Promise<T>; get(id: any): Promise<T | null>; list(filter?: any): Promise<T[]>; update(id: any, input: TU): Promise<T>; delete(id: any): Promise<void> },
  validateCreate: (body: any) => string | null,
  notFoundMsg: string,
  idTransform?: (raw: string) => any,
  mapResult?: (item: T) => any,
  guard?: (c: any) => void,
  itemSchema?: z.ZodType,
): void {
  const idFn = (raw: string): any => idTransform ? idTransform(raw) : raw;
  const map = (item: T): any => mapResult ? mapResult(item) : item;
  const s = itemSchema ?? z.unknown();
  const listSchema = z.object({ items: z.array(s), total: z.number() });

  app.openapi(createRoute({ method: 'get', path: '/', tags: ['topology'], summary: 'List', responses: { 200: { description: 'Items', content: { 'application/json': { schema: OkResponse(listSchema) } } } } }), async (c) => {
    const filter = extractFilter(c);
    const items = await svc.list(Object.keys(filter).length ? filter : undefined);
    return c.json(ok({ items: items.map(map), total: items.length }));
  });

  app.openapi(createRoute({ method: 'post', path: '/', tags: ['topology'], summary: 'Create', responses: { 201: { description: 'Created', content: { 'application/json': { schema: OkResponse(s) } } } } }), async (c) => {
    if (guard) guard(c);
    const body = await z.unknown().parse(c.req.json());
    const err = validateCreate(body);
    if (err) throw new AppError(400, 'VALIDATION_ERROR', err);
    const entity = await svc.create(body);
    return c.json(ok(map(entity)), 201);
  });

  app.openapi(createRoute({ method: 'get', path: '/{id}', tags: ['topology'], summary: 'Get', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Item', content: { 'application/json': { schema: OkResponse(s) } } }, 404: { description: 'Not found' } } }), async (c) => {
    const entity = await svc.get(idFn(c.req.param('id')));
    if (!entity) throw new AppError(404, 'NOT_FOUND', notFoundMsg);
    return c.json(ok(map(entity)));
  });

  app.openapi(createRoute({ method: 'put', path: '/{id}', tags: ['topology'], summary: 'Update', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Updated', content: { 'application/json': { schema: OkResponse(s) } } } } }), async (c) => {
    if (guard) guard(c);
    const body = await z.unknown().parse(c.req.json());
    const entity = await svc.update(idFn(c.req.param('id')), body);
    return c.json(ok(map(entity)));
  });

  app.openapi(createRoute({ method: 'delete', path: '/{id}', tags: ['topology'], summary: 'Delete', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: OkResponse(z.null()) } } } } }), async (c) => {
    if (guard) guard(c);
    await svc.delete(idFn(c.req.param('id')));
    return c.json(ok(null));
  });
}

// ═══════════════════════════════════════════════════════════════

export function createTopologyRouter(
  buckets: BucketService,
  instances: InstanceService,
  images: ImageRepositoryService,
  credentials?: CredentialService,
  policyManager?: S3PolicyManager,
  s3Provider?: IS3Provider,
): OpenAPIHono<{ Variables: AppContext }> {
  const app = new OpenAPIHono<{ Variables: AppContext }>();

  // GET /regions
  app.openapi(createRoute({ method: 'get', path: '/regions', tags: ['topology'], summary: '列出已知 region', responses: { 200: { description: '{ platform, regions[] }', content: { 'application/json': { schema: OkResponse(z.object({ platform: z.string().optional(), regions: z.array(z.string()) })) } } } } }), async (c) => {
    const platform = c.req.query('platform');
    let regionList: string[];
    if (!platform) {
      regionList = [...Object.values(AlibabaRegion), ...Object.values(AwsRegion), ...Object.values(PodmanRegion)];
    } else {
      switch (platform) {
        case 'alibaba': regionList = Object.values(AlibabaRegion); break;
        case 'aws': regionList = Object.values(AwsRegion); break;
        case 'podman': regionList = Object.values(PodmanRegion); break;
        default: regionList = [];
      }
    }
    return c.json(ok({ platform, regions: regionList }));
  });

  // ─── Instance CRUD sub-app ───
  {
    const sub = new OpenAPIHono<any>();
    mkTopoCrud(sub, instances, (body: CreateInstanceBody) => {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- API boundary: body keys are runtime-optional
      if (!body.name || !body.platform || !body.region) return 'name, platform, and region are required';
      if (body.platform === 'podman' && !body.endpoint?.trim()) return 'endpoint is required for podman platform';
      return null;
    }, 'Instance not found', (raw) => createInstanceId(raw), undefined, undefined, ComputeInstanceSchema);
    app.route('/instances', sub);
  }

  // POST /instances/:id/heartbeat
  app.openapi(createRoute({ method: 'post', path: '/instances/{id}/heartbeat', tags: ['topology'], summary: '上报实例心跳', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'OK', content: { 'application/json': { schema: OkResponse(z.null()) } } } } }), async (c) => {
    const id = createInstanceId(c.req.param('id'));
    const body = await z.unknown().parse(c.req.json());
    await instances.heartbeat(id, body.capacity, body.status ?? 'online');
    return c.json(ok(null));
  });

  // ─── Credential CRUD ───
  if (credentials) {
    const sub = new OpenAPIHono<any>();
    mkTopoCrud(sub, credentials, (body: CreateCredentialBody) => {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- API boundary
      if (!body.name || !body.type || !body.platform) return 'name, type, and platform are required';
      if (body.type === 'aksk' && (!body.accessKeyId || !body.accessKeySecret)) return 'accessKeyId and accessKeySecret are required for aksk type';
      if (body.type === 'token' && !body.token) return 'token is required for token type';
      if (body.type === 'password' && (!body.username || !body.password)) return 'username and password are required for password type';
      return null;
    }, 'Credential not found', undefined, (c) => toMasked(c), undefined, MaskedCredentialSchema);
    app.route('/credentials', sub);
  }

  // ─── Bucket CRUD ───
  {
    const sub = new OpenAPIHono<any>();
    mkTopoCrud(sub, buckets, (body: CreateBucketBody) => {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- API boundary
      if (!body.name || !body.bucketType || !body.instanceId) return 'name, bucketType, and instanceId are required';
      return null;
    }, 'Bucket not found', undefined, undefined, undefined, RegionBucketSchema);
    app.route('/buckets', sub);
  }

  // ─── S3 Policy ───
  if (policyManager) {
    app.openapi(createRoute({ method: 'get', path: '/buckets/{id}/policies', tags: ['topology'], summary: '列出 bucket 的 S3 策略', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: '{ items: S3Policy[] }', content: { 'application/json': { schema: OkResponse(z.object({ items: z.array(S3PolicySchema), total: z.number() })) } } } } }), async (c) => {
      const items = await policyManager.list(c.req.param('id'));
      return c.json(ok({ items, total: items.length }));
    });

    app.openapi(createRoute({ method: 'post', path: '/buckets/{id}/policies', tags: ['topology'], summary: '创建 S3 策略', request: { params: z.object({ id: z.string() }) }, responses: { 201: { description: 'S3Policy', content: { 'application/json': { schema: OkResponse(S3PolicySchema) } } } } }), async (c) => {
      isRoot(c);
      const body = await z.unknown().parse(c.req.json());
      const policy = await policyManager.create(c.req.param('id'), body as CreateS3PolicyInput);
      return c.json(ok(policy), 201);
    });

    app.openapi(createRoute({ method: 'get', path: '/policies/{id}', tags: ['topology'], summary: '获取 S3 策略详情', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'S3Policy', content: { 'application/json': { schema: OkResponse(S3PolicySchema) } } }, 404: { description: 'Not found' } } }), async (c) => {
      const policy = await policyManager.get(c.req.param('id'));
      if (!policy) throw new AppError(404, 'NOT_FOUND', 'S3 policy not found');
      return c.json(ok(policy));
    });

    app.openapi(createRoute({ method: 'put', path: '/policies/{id}', tags: ['topology'], summary: '更新 S3 策略', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'S3Policy', content: { 'application/json': { schema: OkResponse(S3PolicySchema) } } } } }), async (c) => {
      isRoot(c);
      const body = await z.unknown().parse(c.req.json());
      const policy = await policyManager.update(c.req.param('id'), body as UpdateS3PolicyInput);
      return c.json(ok(policy));
    });

    app.openapi(createRoute({ method: 'delete', path: '/policies/{id}', tags: ['topology'], summary: '删除 S3 策略', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: OkResponse(z.null()) } } } } }), async (c) => {
      isRoot(c);
      await policyManager.delete(c.req.param('id'));
      return c.json(ok(null));
    });
  }

  // ─── Image Repository CRUD ───
  {
    const sub = new OpenAPIHono<any>();
    mkTopoCrud(sub, images, (body: CreateImageInput) => {
      if (!body.name || !body.instanceId || !body.image) return 'name, instanceId, and image are required';
      return null;
    }, 'ImageRepository not found', undefined, undefined, undefined, ImageRepositorySchema);
    app.route('/images', sub);
  }

  // ─── Image Pull ───
  app.openapi(createRoute({ method: 'post', path: '/images/{id}/pull', tags: ['topology'], summary: '异步拉取镜像', request: { params: z.object({ id: z.string() }) }, responses: { 202: { description: '{ taskId }', content: { 'application/json': { schema: OkResponse(z.object({ taskId: z.string() })) } } } } }), async (c) => {
    const id = c.req.param('id');
    const repo = await images.get(id);
    if (!repo) throw new AppError(404, 'NOT_FOUND', 'ImageRepository not found');
    if (repo.status !== 'active') throw new AppError(400, 'INVALID_STATUS', 'ImageRepository is not active');

    const taskId = `pull_${crypto.randomUUID()}`;
    const task = { id: taskId, repositoryId: id, image: repo.image, status: 'pulling' as const, createdAt: Date.now() };

    await c.var.stores.atomic.set('pull-task:' + taskId, task, null);
    const idxKey = 'pull-task:repo:' + id;
    const idxEntry = await c.var.stores.atomic.get(idxKey) as any;
    await c.var.stores.atomic.set(idxKey, [...(idxEntry?.value ?? []), taskId], idxEntry?.version ?? null);
    await c.var.eventLoop.enqueueTrigger({
      type: 'image.pull',
      payload: { taskId, repositoryId: id, image: repo.image, instanceId: repo.instanceId, clusterId: repo.clusterId, credentialRef: repo.credentialRef, registryCredential: repo.registryCredential },
    });

    return c.json(ok({ taskId }), 202);
  });

  app.openapi(createRoute({ method: 'get', path: '/pull-tasks/{taskId}', tags: ['topology'], summary: '查询拉取任务状态', request: { params: z.object({ taskId: z.string() }) }, responses: { 200: { description: 'PullTask', content: { 'application/json': { schema: OkResponse(PullTaskSchema) } } }, 404: { description: 'Not found' } } }), async (c) => {
    const taskId = c.req.param('taskId');
    const entry = await c.var.stores.atomic.get('pull-task:' + taskId) as any;
    if (!entry) throw new AppError(404, 'NOT_FOUND', 'Pull task not found');
    return c.json(ok(entry.value));
  });

  app.openapi(createRoute({ method: 'get', path: '/images/{id}/tasks', tags: ['topology'], summary: '列出仓库的历史拉取任务', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: '{ items: PullTask[] }', content: { 'application/json': { schema: OkResponse(z.object({ items: z.array(PullTaskSchema), total: z.number() })) } } } } }), async (c) => {
    const idx: any = await c.var.stores.atomic.get('pull-task:repo:' + c.req.param('id'));
    if (!idx) return c.json(ok({ items: [], total: 0 }));
    const entries = await Promise.all((idx.value ?? []).map((tid: string) => c.var.stores.atomic.get('pull-task:' + tid))) as any;
    const tasks = entries.filter((e: any) => e).map((e: any) => e.value);
    return c.json(ok({ items: tasks, total: tasks.length }));
  });

  // ─── S3 Multipart ───
  if (s3Provider) {
    const DEFAULT_PART_SIZE = 5 * 1024 * 1024;
    const DEFAULT_EXPIRES = 3600;

    app.openapi(createRoute({ method: 'post', path: '/buckets/{id}/uploads', tags: ['topology'], summary: '创建分片上传会话', request: { params: z.object({ id: z.string() }) }, responses: { 201: { description: 'UploadSession', content: { 'application/json': { schema: OkResponse(S3MultipartUploadSessionSchema) } } } } }), async (c) => {
      const bucketId = c.req.param('id');
      const bucket = await buckets.get(bucketId);
      if (!bucket) throw new AppError(404, 'NOT_FOUND', 'Bucket not found');
      if (!s3Provider.createMultipartUpload || !s3Provider.putPresignedUrl) throw new AppError(400, 'NOT_SUPPORTED', 'Multi-part upload not supported');
      const body = await z.unknown().parse(c.req.json());
      if (!body.key || !body.parts) throw new AppError(400, 'VALIDATION_ERROR', 'key and parts are required');
      const partSize = body.partSize ?? DEFAULT_PART_SIZE;
      const expiresIn = body.expiresIn ?? DEFAULT_EXPIRES;
      const upload = await s3Provider.createMultipartUpload({ bucket: bucket.name, key: body.key, ...(body.contentType ? { contentType: body.contentType } : {}) });
      const presignedUrls = [];
      for (let i = 1; i <= body.parts; i++) {
        const url = await s3Provider.putPresignedUrl(bucket.name, `${body.key}?partNumber=${String(i)}&uploadId=${upload.uploadId}`, expiresIn);
        presignedUrls.push({ partNumber: i, url });
      }
      const session: S3MultipartUploadSession = { uploadId: upload.uploadId, bucket: bucket.name, key: body.key, presignedUrls, partSize, expiresIn };
      return c.json(ok(session), 201);
    });

    app.openapi(createRoute({ method: 'post', path: '/buckets/{id}/uploads/{uploadId}/complete', tags: ['topology'], summary: '合并分片', request: { params: z.object({ id: z.string(), uploadId: z.string() }) }, responses: { 200: { description: 'Result', content: { 'application/json': { schema: OkResponse(S3MultipartCompleteResultSchema) } } } } }), async (c) => {
      const bucketId = c.req.param('id');
      const bucket = await buckets.get(bucketId);
      if (!bucket) throw new AppError(404, 'NOT_FOUND', 'Bucket not found');
      if (!s3Provider.completeMultipartUpload) throw new AppError(400, 'NOT_SUPPORTED', 'Not supported');
      const body = await z.unknown().parse(c.req.json());
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- API boundary: body from c.req.json<>
      if (!body.key || !body.parts) throw new AppError(400, 'VALIDATION_ERROR', 'key and parts are required');
      const result = await s3Provider.completeMultipartUpload({ bucket: bucket.name, key: body.key, uploadId: c.req.param('uploadId'), parts: body.parts });
      return c.json(ok(result));
    });

    app.openapi(createRoute({ method: 'delete', path: '/buckets/{id}/uploads/{uploadId}', tags: ['topology'], summary: '取消分片上传', request: { params: z.object({ id: z.string(), uploadId: z.string() }) }, responses: { 200: { description: '{ aborted: true }', content: { 'application/json': { schema: OkResponse(z.object({ aborted: z.boolean() })) } } } } }), async (c) => {
      const bucketId = c.req.param('id');
      const bucket = await buckets.get(bucketId);
      if (!bucket) throw new AppError(404, 'NOT_FOUND', 'Bucket not found');
      if (!s3Provider.abortMultipartUpload) throw new AppError(400, 'NOT_SUPPORTED', 'Not supported');
      let body: { key: string };
      try { body = await z.unknown().parse(c.req.json()); } catch { body = { key: '' }; }
      await s3Provider.abortMultipartUpload({ bucket: bucket.name, key: body.key || '', uploadId: c.req.param('uploadId') });
      return c.json(ok({ aborted: true }));
    });

    app.openapi(createRoute({ method: 'get', path: '/buckets/{id}/uploads/{uploadId}/parts', tags: ['topology'], summary: '列出已上传的分片', request: { params: z.object({ id: z.string(), uploadId: z.string() }) }, responses: { 200: { description: 'Parts', content: { 'application/json': { schema: OkResponse(S3ListPartsResultSchema) } } } } }), async (c) => {
      const bucketId = c.req.param('id');
      const bucket = await buckets.get(bucketId);
      if (!bucket) throw new AppError(404, 'NOT_FOUND', 'Bucket not found');
      if (!s3Provider.listParts) throw new AppError(400, 'NOT_SUPPORTED', 'Not supported');
      const key = c.req.query('key') ?? '';
      if (!key) throw new AppError(400, 'VALIDATION_ERROR', 'key query param required');
      const parts = await s3Provider.listParts(bucket.name, key, c.req.param('uploadId'));
      return c.json(ok(parts));
    });

    app.openapi(createRoute({ method: 'get', path: '/buckets/{id}/objects/{key}/download', tags: ['topology'], summary: '获取分片下载 presigned URL', request: { params: z.object({ id: z.string(), key: z.string() }) }, responses: { 200: { description: 'DownloadSession', content: { 'application/json': { schema: OkResponse(S3MultipartDownloadSessionSchema) } } } } }), async (c) => {
      const bucketId = c.req.param('id');
      const bucket = await buckets.get(bucketId);
      if (!bucket) throw new AppError(404, 'NOT_FOUND', 'Bucket not found');
      if (!s3Provider.getPresignedUrl) throw new AppError(400, 'NOT_SUPPORTED', 'Presigned URLs not supported');
      const key = c.req.param('key');
      const partSize = parseInt(c.req.query('partSize') ?? String(DEFAULT_PART_SIZE), 10);
      const parts = parseInt(c.req.query('parts') ?? '1', 10);
      const expiresIn = parseInt(c.req.query('expiresIn') ?? String(DEFAULT_EXPIRES), 10);
      const info = await s3Provider.headObject(bucket.name, key);
      if (!info) throw new AppError(404, 'NOT_FOUND', 'Object not found');
      const presignedUrls = [];
      for (let i = 0; i < parts; i++) {
        const start = i * partSize;
        const end = Math.min(start + partSize - 1, info.size - 1);
        if (start >= info.size) break;
        const range = `bytes=${String(start)}-${String(end)}`;
        const url = await s3Provider.getPresignedUrl(bucket.name, key, expiresIn);
        presignedUrls.push({ partNumber: i + 1, url: `${url}&range=${encodeURIComponent(range)}`, range });
      }
      const session: S3MultipartDownloadSession = { bucket: bucket.name, key, size: info.size, presignedUrls };
      return c.json(ok(session));
    });
  }

  return app;
}
