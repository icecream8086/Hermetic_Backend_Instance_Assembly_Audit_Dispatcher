import { Hono } from 'hono';
import type { Context } from 'hono';
import type { BucketService, InstanceService, ImageRepositoryService } from '../../core/region/index.ts';
import { createInstanceId } from '../../core/region/index.ts';
import type { CreateImageInput } from '../../core/region/image.ts';
import { AlibabaRegion, AwsRegion, PodmanRegion } from '../../core/region/types.ts';
import type { AppContext } from '../../core/deps.ts';
import { ok, fail } from '../../core/response.ts';
import type { RouteMeta } from '../../core/http-docs/types.ts';
import type {
  CreateBucketBody,
  CreateInstanceBody, HeartbeatBody,
  CreateCredentialBody,
} from './types.ts';
import type { CredentialService} from '../../core/auth/credential.ts';
import { toMasked } from '../../core/auth/credential.ts';
import type { S3PolicyManager } from '../../core/s3-policy/manager.ts';
import type { CreateS3PolicyInput, UpdateS3PolicyInput } from '../../core/s3-policy/types.ts';
import type { IS3Provider } from '../../core/provider/s3.ts';
import type { S3MultipartUploadSession, S3MultipartDownloadSession } from '../../core/provider/s3-types.ts';
import type { CrudHandlerMap } from '../../core/crud/router.ts';
import { registerCrudRoutes } from '../../core/crud/router.ts';

function requireRoot(c: Context<{ Variables: AppContext }>): Response | null {
  const user = c.var?.currentUser;
  if (!user) return null;
  const isRoot = user.role === 'root' || user.role === 'Operator' || user.role === 'wheel';
  if (!isRoot) return c.json(fail('FORBIDDEN', 'Admin access required'), 403);
  return null;
}

// ─── Generic CRUD sub-router helper for topology services ───

/** Contract that all topology services satisfy. */
interface TopoCrudSvc<T, TC = any, TU = any> {
  create(input: TC): Promise<T>;
  get(id: any): Promise<T | null>;
  list(filter?: any): Promise<T[]>;
  update(id: any, input: TU): Promise<T>;
  delete(id: any): Promise<void>;
}

/** Options to tune the generated CrudHandlerMap for a specific sub-resource. */
interface TopoCrudOpts<T, TC, TU> {
  svc: TopoCrudSvc<T, TC, TU>;
  /** Validate create body. Return null if valid, error message string if invalid. */
  validateCreate: (body: any) => string | null;
  /** Optional ID transform (e.g. createInstanceId). Default: identity. */
  idTransform?: (raw: string) => any;
  /** Optional transform on response objects (e.g. toMasked). Default: identity. */
  mapResult?: (item: T) => any;
  /** Response field name for the entity. Default: singularized from route. */
  notFoundMsg: string;
  /** Optional guard function for create/update/delete */
  guard?: (c: Context) => Response | null;
}

function mkTopoCrud<T, TC = any, TU = any>(opts: TopoCrudOpts<T, TC, TU>): CrudHandlerMap {
  const id = (raw: string) => opts.idTransform ? opts.idTransform(raw) : raw;
  const map = (item: T): any => opts.mapResult ? opts.mapResult(item) : item;

  return {
    list: (r) => r.get('/', async (c) => {
      const filter = extractFilter(c);
      const items = await opts.svc.list(Object.keys(filter).length ? filter : undefined);
      return c.json(ok({ items: items.map(map), total: items.length }));
    }),

    create: (r) => r.post('/', async (c) => {
      if (opts.guard) { const rv = opts.guard(c); if (rv) return rv; }
      try {
        const body = await c.req.json<TC>();
        const err = opts.validateCreate(body);
        if (err) return c.json(fail('VALIDATION_ERROR', err), 400);
        const entity = await opts.svc.create(body);
        return c.json(ok(map(entity)), 201);
      } catch (e: any) {
        return c.json(fail('CREATE_FAILED', e.message), 400);
      }
    }),

    get: (r) => r.get('/:id', async (c) => {
      const entity = await opts.svc.get(id(c.req.param('id')));
      if (!entity) return c.json(fail('NOT_FOUND', opts.notFoundMsg), 404);
      return c.json(ok(map(entity)));
    }),

    update: (r) => r.put('/:id', async (c) => {
      if (opts.guard) { const rv = opts.guard(c); if (rv) return rv; }
      try {
        const body = await c.req.json<TU>();
        const entity = await opts.svc.update(id(c.req.param('id')), body);
        return c.json(ok(map(entity)));
      } catch (e: any) {
        return c.json(fail('UPDATE_FAILED', e.message), e.status ?? 400);
      }
    }),

    delete: (r) => r.delete('/:id', async (c) => {
      if (opts.guard) { const rv = opts.guard(c); if (rv) return rv; }
      try {
        await opts.svc.delete(id(c.req.param('id')));
        return c.json(ok(null));
      } catch (e: any) {
        return c.json(fail('DELETE_FAILED', e.message), e.status ?? 400);
      }
    }),
  };
}

/** Extract filter params from query string based on known keys for each sub-resource. */
function extractFilter(c: Context): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of ['region', 'platform', 'status']) {
    const v = c.req.query(key);
    if (v) out[key] = v;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// Main router
// ═══════════════════════════════════════════════════════════════

export function createTopologyRouter(
  buckets: BucketService,
  instances: InstanceService,
  images: ImageRepositoryService,
  credentials?: CredentialService,
  policyManager?: S3PolicyManager,
  s3Provider?: IS3Provider,
): Hono<{ Variables: AppContext }> {
  const router = new Hono<{ Variables: AppContext }>();

  // ─── Region listing ───
  router.get('/regions', async (c) => {
    const platform = c.req.query('platform');
    let regionList: string[];
    switch (platform) {
      case 'alibaba': regionList = Object.values(AlibabaRegion); break;
      case 'aws': regionList = Object.values(AwsRegion); break;
      case 'podman': regionList = Object.values(PodmanRegion); break;
      default: regionList = [...Object.values(AlibabaRegion), ...Object.values(AwsRegion), ...Object.values(PodmanRegion)];
    }
    return c.json(ok({ platform, regions: regionList }));
  });

  // ─── Instance CRUD ───
  {
    const sub = new Hono<any>();
    registerCrudRoutes(sub, mkTopoCrud({
      svc: instances,
      idTransform: (raw) => createInstanceId(raw),
      validateCreate: (body: CreateInstanceBody) => {
        if (!body.name || !body.platform || !body.region) return 'name, platform, and region are required';
        if (body.platform === 'podman' && !body.endpoint?.trim()) return 'endpoint is required for podman platform';
        return null;
      },
      notFoundMsg: 'Instance not found',
    }));
    router.route('/instances', sub);
    router.route('/instances/', sub);
  }

  // ─── Instance heartbeat (extra) ───
  router.post('/instances/:id/heartbeat', async (c) => {
    try {
      const id = createInstanceId(c.req.param('id'));
      const body = await c.req.json<HeartbeatBody>();
      await instances.heartbeat(id, body.capacity, body.status ?? 'online');
      return c.json(ok(null));
    } catch (e: any) {
      return c.json(fail('HEARTBEAT_FAILED', e.message), 400);
    }
  });

  // ─── Credential CRUD ───
  if (credentials) {
    const sub = new Hono<any>();
    registerCrudRoutes(sub, mkTopoCrud({
      svc: credentials,
      mapResult: (c) => toMasked(c),
      validateCreate: (body: CreateCredentialBody) => {
        if (!body.name || !body.type || !body.platform) return 'name, type, and platform are required';
        if (body.type === 'aksk' && (!body.accessKeyId || !body.accessKeySecret)) return 'accessKeyId and accessKeySecret are required for aksk type';
        if (body.type === 'token' && !body.token) return 'token is required for token type';
        if (body.type === 'password' && (!body.username || !body.password)) return 'username and password are required for password type';
        return null;
      },
      notFoundMsg: 'Credential not found',
    }));
    router.route('/credentials', sub);
    router.route('/credentials/', sub);
  }

  // ─── Bucket CRUD ───
  {
    const sub = new Hono<any>();
    registerCrudRoutes(sub, mkTopoCrud({
      svc: buckets,
      validateCreate: (body: CreateBucketBody) => {
        if (!body.name || !body.bucketType || !body.instanceId) return 'name, bucketType, and instanceId are required';
        return null;
      },
      notFoundMsg: 'Bucket not found',
    }));
    router.route('/buckets', sub);
    router.route('/buckets/', sub);
  }

  // ─── S3 Policy CRUD (nested: list/create under /buckets/:id, get/update/delete under /policies/:id) ───
  if (policyManager) {
    router.get('/buckets/:id/policies', async (c) => {
      const items = await policyManager.list(c.req.param('id'));
      return c.json(ok({ items, total: items.length }));
    });

    router.post('/buckets/:id/policies', async (c) => {
      const r = requireRoot(c); if (r) return r;
      try {
        const body: unknown = await c.req.json();
        const policy = await policyManager.create(c.req.param('id'), body as CreateS3PolicyInput);
        return c.json(ok(policy), 201);
      } catch (e: any) {
        return c.json(fail('CREATE_FAILED', e.message), 400);
      }
    });

    router.get('/policies/:id', async (c) => {
      const policy = await policyManager.get(c.req.param('id'));
      if (!policy) return c.json(fail('NOT_FOUND', 'S3 policy not found'), 404);
      return c.json(ok(policy));
    });
    router.put('/policies/:id', async (c) => {
      const r = requireRoot(c); if (r) return r;
      try {
        const body: unknown = await c.req.json();
        const policy = await policyManager.update(c.req.param('id'), body as UpdateS3PolicyInput);
        return c.json(ok(policy));
      } catch (e: any) {
        return c.json(fail('UPDATE_FAILED', e.message), e.status ?? 400);
      }
    });
    router.delete('/policies/:id', async (c) => {
      const r = requireRoot(c); if (r) return r;
      try {
        await policyManager.delete(c.req.param('id'));
        return c.json(ok(null));
      } catch (e: any) {
        return c.json(fail('DELETE_FAILED', e.message), e.status ?? 400);
      }
    });
  }

  // ─── Image Repository CRUD ───
  {
    const sub = new Hono<any>();
    registerCrudRoutes(sub, mkTopoCrud({
      svc: images,
      validateCreate: (body: CreateImageInput) => {
        if (!body.name || !body.instanceId || !body.image) return 'name, instanceId, and image are required';
        return null;
      },
      notFoundMsg: 'ImageRepository not found',
    }));
    router.route('/images', sub);
    router.route('/images/', sub);
  }

  // ─── Image Pull (async) ───
  router.post('/images/:id/pull', async (c) => {
    try {
      const id = c.req.param('id');
      const repo = await images.get(id);
      if (!repo) return c.json(fail('NOT_FOUND', 'ImageRepository not found'), 404);
      if (repo.status !== 'active') return c.json(fail('INVALID_STATUS', 'ImageRepository is not active'), 400);

      const taskId = `pull_${crypto.randomUUID()}`;
      const task = { id: taskId, repositoryId: id, image: repo.image, status: 'pulling' as const, createdAt: Date.now() };

      await c.var.stores.atomic.set('pull-task:' + taskId, task, null);
      const idxKey = 'pull-task:repo:' + id;
      const idxEntry = await c.var.stores.atomic.get<string[]>(idxKey);
      await c.var.stores.atomic.set(idxKey, [...(idxEntry?.value ?? []), taskId], idxEntry?.version ?? null);
      await c.var.eventLoop.enqueueTrigger({
        type: 'image.pull',
        payload: {
          taskId, repositoryId: id, image: repo.image,
          instanceId: repo.instanceId, clusterId: repo.clusterId,
          credentialRef: repo.credentialRef,
          registryCredential: repo.registryCredential,
        },
      });

      return c.json(ok({ taskId }), 202);
    } catch (e: any) {
      return c.json(fail('PULL_FAILED', e.message), 502);
    }
  });

  router.get('/pull-tasks/:taskId', async (c) => {
    const taskId = c.req.param('taskId');
    const entry = await c.var.stores.atomic.get<any>('pull-task:' + taskId);
    if (!entry) return c.json(fail('NOT_FOUND', 'Pull task not found'), 404);
    return c.json(ok(entry.value));
  });

  router.get('/images/:id/tasks', async (c) => {
    const idx = await c.var.stores.atomic.get<string[]>('pull-task:repo:' + c.req.param('id'));
    if (!idx) return c.json(ok({ items: [], total: 0 }));
    const entries = await Promise.all(idx.value.map((tid: string) => c.var.stores.atomic.get<any>('pull-task:' + tid)));
    const tasks = entries.filter(e => e).map(e => e!.value);
    return c.json(ok({ items: tasks, total: tasks.length }));
  });

  // ─── Multi-part upload / download ───
  if (s3Provider) {
    const DEFAULT_PART_SIZE = 5 * 1024 * 1024;
    const DEFAULT_EXPIRES = 3600;

    router.post('/buckets/:id/uploads', async (c) => {
      const bucketId = c.req.param('id');
      const bucket = await buckets.get(bucketId);
      if (!bucket) return c.json(fail('NOT_FOUND', 'Bucket not found'), 404);
      if (!s3Provider.createMultipartUpload || !s3Provider.putPresignedUrl) {
        return c.json(fail('NOT_SUPPORTED', 'Multi-part upload not supported by this provider'), 400);
      }
      try {
        const body = await c.req.json<{ key: string; contentType?: string; partSize?: number; parts: number; expiresIn?: number }>();
        if (!body.key || !body.parts) return c.json(fail('VALIDATION_ERROR', 'key and parts are required'), 400);
        const partSize = body.partSize ?? DEFAULT_PART_SIZE;
        const expiresIn = body.expiresIn ?? DEFAULT_EXPIRES;

        const upload = await s3Provider.createMultipartUpload({
          bucket: bucket.name, key: body.key,
          ...(body.contentType ? { contentType: body.contentType } : {}),
        });

        const presignedUrls = [];
        for (let i = 1; i <= body.parts; i++) {
          const url = await (s3Provider.putPresignedUrl
            ? s3Provider.putPresignedUrl(bucket.name, `${body.key}?partNumber=${String(i)}&uploadId=${upload.uploadId}`, expiresIn)
            : Promise.resolve(''));
          presignedUrls.push({ partNumber: i, url });
        }

        const session: S3MultipartUploadSession = {
          uploadId: upload.uploadId, bucket: bucket.name, key: body.key,
          presignedUrls, partSize, expiresIn,
        };
        return c.json(ok(session), 201);
      } catch (e: any) {
        return c.json(fail('UPLOAD_FAILED', e.message), 500);
      }
    });

    router.post('/buckets/:id/uploads/:uploadId/complete', async (c) => {
      const bucketId = c.req.param('id');
      const bucket = await buckets.get(bucketId);
      if (!bucket) return c.json(fail('NOT_FOUND', 'Bucket not found'), 404);
      if (!s3Provider.completeMultipartUpload) return c.json(fail('NOT_SUPPORTED', 'Not supported'), 400);
      try {
        const body = await c.req.json<{ key: string; parts: { partNumber: number; etag: string }[] }>();
        if (!body.key || !body.parts) return c.json(fail('VALIDATION_ERROR', 'key and parts are required'), 400);
        const result = await s3Provider.completeMultipartUpload({
          bucket: bucket.name, key: body.key,
          uploadId: c.req.param('uploadId'), parts: body.parts,
        });
        return c.json(ok(result));
      } catch (e: any) {
        return c.json(fail('COMPLETE_FAILED', e.message), 500);
      }
    });

    router.delete('/buckets/:id/uploads/:uploadId', async (c) => {
      const bucketId = c.req.param('id');
      const bucket = await buckets.get(bucketId);
      if (!bucket) return c.json(fail('NOT_FOUND', 'Bucket not found'), 404);
      if (!s3Provider.abortMultipartUpload) return c.json(fail('NOT_SUPPORTED', 'Not supported'), 400);
      const body = await c.req.json<{ key: string }>().catch(() => ({ key: '' }));
      await s3Provider.abortMultipartUpload({ bucket: bucket.name, key: body.key || '', uploadId: c.req.param('uploadId') });
      return c.json(ok({ aborted: true }));
    });

    router.get('/buckets/:id/uploads/:uploadId/parts', async (c) => {
      const bucketId = c.req.param('id');
      const bucket = await buckets.get(bucketId);
      if (!bucket) return c.json(fail('NOT_FOUND', 'Bucket not found'), 404);
      if (!s3Provider.listParts) return c.json(fail('NOT_SUPPORTED', 'Not supported'), 400);
      const key = c.req.query('key') ?? '';
      if (!key) return c.json(fail('VALIDATION_ERROR', 'key query param required'), 400);
      const parts = await s3Provider.listParts(bucket.name, key, c.req.param('uploadId'));
      return c.json(ok(parts));
    });

    router.get('/buckets/:id/objects/:key/download', async (c) => {
      const bucketId = c.req.param('id');
      const bucket = await buckets.get(bucketId);
      if (!bucket) return c.json(fail('NOT_FOUND', 'Bucket not found'), 404);
      if (!s3Provider.getPresignedUrl) return c.json(fail('NOT_SUPPORTED', 'Presigned URLs not supported'), 400);

      const key = c.req.param('key');
      const partSize = parseInt(c.req.query('partSize') ?? String(DEFAULT_PART_SIZE), 10);
      const parts = parseInt(c.req.query('parts') ?? '1', 10);
      const expiresIn = parseInt(c.req.query('expiresIn') ?? String(DEFAULT_EXPIRES), 10);

      const info = await s3Provider.headObject(bucket.name, key);
      if (!info) return c.json(fail('NOT_FOUND', 'Object not found'), 404);

      const presignedUrls = [];
      for (let i = 0; i < parts; i++) {
        const start = i * partSize;
        const end = Math.min(start + partSize - 1, info.size - 1);
        if (start >= info.size) break;
        const range = `bytes=${String(start)}-${String(end)}`;
        const url = await s3Provider.getPresignedUrl(bucket.name, key, expiresIn);
        const urlWithRange = `${url}&range=${encodeURIComponent(range)}`;
        presignedUrls.push({ partNumber: i + 1, url: urlWithRange, range });
      }

      const session: S3MultipartDownloadSession = {
        bucket: bucket.name, key, size: info.size, presignedUrls,
      };
      return c.json(ok(session));
    });
  }

  return router;
}

export const topologyRouteMeta: RouteMeta[] = [
  { method: 'GET', path: '/regions', description: '列出已知 region（?platform=alibaba|aws|podman）', responseDescription: '{ platform, regions[] }' },
  { method: 'GET', path: '/buckets', description: '列出 region-scoped 存储桶', responseDescription: '{ items: RegionBucket[] }' },
  { method: 'GET', path: '/buckets/:id/policies', description: '列出指定 bucket 的 S3 策略', responseDescription: '{ items: S3Policy[] }' },
  { method: 'POST', path: '/buckets/:id/policies', description: '创建 S3 策略（admin only）', requestBody: { name: 'read-static', effect: 'Allow', actions: ['s3:GetObject'], pathPrefix: 'static/' }, responseDescription: 'S3Policy' },
  { method: 'GET', path: '/policies/:id', description: '获取 S3 策略详情', responseDescription: 'S3Policy' },
  { method: 'PUT', path: '/policies/:id', description: '更新 S3 策略（admin only）', responseDescription: 'S3Policy' },
  { method: 'DELETE', path: '/policies/:id', description: '删除 S3 策略（admin only）', responseDescription: '{ ok: true }' },
  { method: 'POST', path: '/buckets', description: '创建 region bucket 记录（autoGenerateKeys=true 自动签发 S3 密钥）', requestBody: { name: 'game-saves', bucketType: 'minio', instanceId: 'inst_xxx', autoGenerateKeys: true }, responseDescription: 'RegionBucket' },
  { method: 'PUT', path: '/buckets/:id', description: '更新 bucket 记录（含 autoGenerateKeys）', responseDescription: 'RegionBucket' },
  { method: 'DELETE', path: '/buckets/:id', description: '删除 bucket 记录', responseDescription: '{ ok: true }' },
  { method: 'GET', path: '/instances', description: '列出计算实例（?region=&platform=&status=）', responseDescription: '{ items: ComputeInstance[] }' },
  { method: 'POST', path: '/instances', description: '创建计算实例', responseDescription: 'ComputeInstance' },
  { method: 'GET', path: '/instances/:id', description: '获取实例详情', responseDescription: 'ComputeInstance' },
  { method: 'PUT', path: '/instances/:id', description: '更新实例配置', responseDescription: 'ComputeInstance' },
  { method: 'DELETE', path: '/instances/:id', description: '删除计算实例', responseDescription: '{ ok: true }' },
  { method: 'POST', path: '/instances/:id/heartbeat', description: '上报实例心跳（容量 + 状态）', responseDescription: '{ ok: true }' },
  { method: 'GET', path: '/credentials', description: '列出凭证（secret 自动 masking）', responseDescription: '{ items: MaskedCredential[] }' },
  { method: 'POST', path: '/credentials', description: '创建凭证', responseDescription: 'MaskedCredential' },
  { method: 'GET', path: '/credentials/:id', description: '查看凭证详情（secret masked）', responseDescription: 'MaskedCredential' },
  { method: 'PUT', path: '/credentials/:id', description: '更新凭证', responseDescription: 'MaskedCredential' },
  { method: 'DELETE', path: '/credentials/:id', description: '删除凭证', responseDescription: '{ ok: true }' },
  { method: 'GET', path: '/images', description: '列出镜像仓库（?platform=&status=）', responseDescription: '{ items: ImageRepository[] }' },
  { method: 'POST', path: '/images', description: '创建镜像仓库（绑定到计算实例）', responseDescription: 'ImageRepository' },
  { method: 'GET', path: '/images/:id', description: '查看镜像仓库详情', responseDescription: 'ImageRepository' },
  { method: 'PUT', path: '/images/:id', description: '更新镜像仓库', responseDescription: 'ImageRepository' },
  { method: 'DELETE', path: '/images/:id', description: '删除镜像仓库', responseDescription: '{ ok: true }' },
  { method: 'POST', path: '/images/:id/pull', description: '异步拉取镜像（返回 taskId，轮询 pull-tasks/:taskId 确认完成）', responseDescription: '{ taskId }' },
  { method: 'GET', path: '/pull-tasks/:taskId', description: '查询拉取任务状态', responseDescription: '{ id, status, result? }' },
  { method: 'GET', path: '/images/:id/tasks', description: '列出某个仓库的历史拉取任务', responseDescription: '{ items: PullTask[] }' },
  { method: 'POST', path: '/buckets/:id/uploads', description: '创建分片上传会话 — 返回 per-part presigned PUT URL 列表（admin only）', requestBody: { key: 'large-file.zip', contentType: 'application/zip', partSize: 5242880, parts: 4, expiresIn: 3600 }, responseDescription: '{ uploadId, bucket, key, presignedUrls: [{ partNumber, url }], partSize, expiresIn }' },
  { method: 'POST', path: '/buckets/:id/uploads/:uploadId/complete', description: '合并所有分片为完整对象（admin only）', requestBody: { key: 'large-file.zip', parts: [{ partNumber: 1, etag: '"abc123"' }] }, responseDescription: '{ location? }' },
  { method: 'DELETE', path: '/buckets/:id/uploads/:uploadId', description: '取消分片上传 — 删除已上传的分片（admin only）', requestBody: { key: 'large-file.zip' }, responseDescription: '{ aborted: true }' },
  { method: 'GET', path: '/buckets/:id/uploads/:uploadId/parts', description: '列出已上传的分片（admin only）', queryExamples: [{ key: 'large-file.zip' }], responseDescription: '{ parts: [{ partNumber, size, etag }], uploadId, isTruncated }' },
  { method: 'GET', path: '/buckets/:id/objects/:key/download', description: '获取分片下载 presigned GET URL 列表 — 用于多线程下载', queryExamples: [{ partSize: '5242880', parts: '4', expiresIn: '3600' }], responseDescription: '{ bucket, key, size, presignedUrls: [{ partNumber, url, range }] }' },
];
