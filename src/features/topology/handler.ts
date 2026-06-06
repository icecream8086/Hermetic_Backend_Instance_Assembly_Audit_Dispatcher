import { Hono } from 'hono';
import type { BucketService, InstanceService, ImageRepositoryService } from '../../core/region/index.ts';
import type { CreateImageInput, UpdateImageInput } from '../../core/region/image.ts';
import { AlibabaRegion, AwsRegion, PodmanRegion } from '../../core/region/types.ts';
import type { AppContext } from '../../core/app.ts';
import { ok, fail } from '../../core/response.ts';
import type { RouteMeta } from '../../core/http-docs/types.ts';
import type {
  CreateBucketBody, UpdateBucketBody,
  CreateInstanceBody, UpdateInstanceBody, HeartbeatBody,
  CreateCredentialBody, UpdateCredentialBody,
} from './types.ts';
import { CredentialService, toMasked } from '../../core/auth/credential.ts';

export function createTopologyRouter(
  buckets: BucketService,
  instances: InstanceService,
  images: ImageRepositoryService,
  credentials?: CredentialService,
): Hono<{ Variables: AppContext }> {
  const router = new Hono<{ Variables: AppContext }>();

  // ─── Region listing ───

  router.get('/regions', async (c) => {
    const platform = c.req.query('platform');
    let regions: string[];
    switch (platform) {
      case 'alibaba':
        regions = Object.values(AlibabaRegion);
        break;
      case 'aws':
        regions = Object.values(AwsRegion);
        break;
      case 'podman':
        regions = Object.values(PodmanRegion);
        break;
      default:
        // Return all known regions grouped by platform
        regions = [
          ...Object.values(AlibabaRegion),
          ...Object.values(AwsRegion),
          ...Object.values(PodmanRegion),
        ];
    }
    return c.json(ok({ platform, regions }));
  });

  // ─── Instance CRUD ───

  router.get('/instances', async (c) => {
    const region = c.req.query('region');
    const platform = c.req.query('platform');
    const status = c.req.query('status');
    const items = await instances.list(
      region || platform || status ? { region, platform, status } : undefined,
    );
    return c.json(ok({ items, total: items.length }));
  });

  router.post('/instances', async (c) => {
    try {
      const body = await c.req.json<CreateInstanceBody>();
      if (!body.name || !body.platform || !body.region || !body.zone || !body.endpoint) {
        return c.json(fail('VALIDATION_ERROR', 'name, platform, region, zone, and endpoint are required'), 400);
      }
      const instance = await instances.create(body);
      return c.json(ok(instance), 201);
    } catch (e: any) {
      return c.json(fail('CREATE_FAILED', e.message), 400);
    }
  });

  router.get('/instances/:id', async (c) => {
    const id = c.req.param('id') as any;
    const instance = await instances.get(id);
    if (!instance) return c.json(fail('NOT_FOUND', 'Instance not found'), 404);
    return c.json(ok(instance));
  });

  router.put('/instances/:id', async (c) => {
    try {
      const id = c.req.param('id') as any;
      const body = await c.req.json<UpdateInstanceBody>();
      const instance = await instances.update(id, body);
      return c.json(ok(instance));
    } catch (e: any) {
      return c.json(fail('UPDATE_FAILED', e.message), e.status ?? 400);
    }
  });

  router.delete('/instances/:id', async (c) => {
    try {
      const id = c.req.param('id') as any;
      await instances.delete(id);
      return c.json(ok(null));
    } catch (e: any) {
      return c.json(fail('DELETE_FAILED', e.message), e.status ?? 400);
    }
  });

  router.post('/instances/:id/heartbeat', async (c) => {
    try {
      const id = c.req.param('id') as any;
      const body = await c.req.json<HeartbeatBody>();
      await instances.heartbeat(id, body.capacity, body.status ?? 'online');
      return c.json(ok(null));
    } catch (e: any) {
      return c.json(fail('HEARTBEAT_FAILED', e.message), 400);
    }
  });

  // ─── Credential CRUD ───

  if (credentials) {
    router.get('/credentials', async (c) => {
      const platform = c.req.query('platform');
      const items = await credentials.list(platform ? { platform } : undefined);
      return c.json(ok({ items: items.map(toMasked), total: items.length }));
    });

    router.post('/credentials', async (c) => {
      try {
        const body = await c.req.json<CreateCredentialBody>();
        if (!body.name || !body.type || !body.platform) {
          return c.json(fail('VALIDATION_ERROR', 'name, type, and platform are required'), 400);
        }
        if (body.type === 'aksk' && (!body.accessKeyId || !body.accessKeySecret)) {
          return c.json(fail('VALIDATION_ERROR', 'accessKeyId and accessKeySecret are required for aksk type'), 400);
        }
        if (body.type === 'token' && !body.token) {
          return c.json(fail('VALIDATION_ERROR', 'token is required for token type'), 400);
        }
        if (body.type === 'password' && (!body.username || !body.password)) {
          return c.json(fail('VALIDATION_ERROR', 'username and password are required for password type'), 400);
        }
        const cred = await credentials.create(body as any);
        return c.json(ok(toMasked(cred)), 201);
      } catch (e: any) {
        return c.json(fail('CREATE_FAILED', e.message), 400);
      }
    });

    router.get('/credentials/:id', async (c) => {
      const id = c.req.param('id') as any;
      const cred = await credentials.get(id);
      if (!cred) return c.json(fail('NOT_FOUND', 'Credential not found'), 404);
      return c.json(ok(toMasked(cred)));
    });

    router.put('/credentials/:id', async (c) => {
      try {
        const id = c.req.param('id') as any;
        const body = await c.req.json<UpdateCredentialBody>();
        const cred = await credentials.update(id, body);
        return c.json(ok(toMasked(cred)));
      } catch (e: any) {
        return c.json(fail('UPDATE_FAILED', e.message), e.status ?? 400);
      }
    });

    router.delete('/credentials/:id', async (c) => {
      try {
        const id = c.req.param('id') as any;
        await credentials.delete(id);
        return c.json(ok(null));
      } catch (e: any) {
        return c.json(fail('DELETE_FAILED', e.message), e.status ?? 400);
      }
    });
  }

  // ─── Bucket CRUD ───

  router.get('/buckets', async (c) => {
    const platform = c.req.query('platform');
    const region = c.req.query('region');
    const items = await buckets.list(
      platform || region ? { platform, region } : undefined,
    );
    return c.json(ok({ items, total: items.length }));
  });

  router.post('/buckets', async (c) => {
    try {
      const body = await c.req.json<CreateBucketBody>();
      if (!body.name || !body.bucketType || !body.instanceId) {
        return c.json(fail('VALIDATION_ERROR', 'name, platform, region, endpoint, bucketType, and credentialRef are required'), 400);
      }
      const bucket = await buckets.create(body);
      return c.json(ok(bucket), 201);
    } catch (e: any) {
      return c.json(fail('CREATE_FAILED', e.message), 400);
    }
  });

  router.get('/buckets/:id', async (c) => {
    const id = c.req.param('id');
    const bucket = await buckets.get(id);
    if (!bucket) return c.json(fail('NOT_FOUND', 'Bucket not found'), 404);
    return c.json(ok(bucket));
  });

  router.put('/buckets/:id', async (c) => {
    try {
      const id = c.req.param('id');
      const body = await c.req.json<UpdateBucketBody>();
      const bucket = await buckets.update(id, body);
      return c.json(ok(bucket));
    } catch (e: any) {
      return c.json(fail('UPDATE_FAILED', e.message), e.status ?? 400);
    }
  });

  router.delete('/buckets/:id', async (c) => {
    try {
      const id = c.req.param('id');
      await buckets.delete(id);
      return c.json(ok(null));
    } catch (e: any) {
      return c.json(fail('DELETE_FAILED', e.message), e.status ?? 400);
    }
  });

  // ─── Image Repository CRUD ───

  router.get('/images', async (c) => {
    const platform = c.req.query('platform');
    const status = c.req.query('status');
    const items = await images.list(platform || status ? { platform, status } : undefined);
    return c.json(ok({ items, total: items.length }));
  });

  router.post('/images', async (c) => {
    try {
      const body = await c.req.json<CreateImageInput>();
      if (!body.name || !body.instanceId || !body.image) {
        return c.json(fail('VALIDATION_ERROR', 'name, instanceId, and image are required'), 400);
      }
      const repo = await images.create(body);
      return c.json(ok(repo), 201);
    } catch (e: any) {
      return c.json(fail('CREATE_FAILED', e.message), 400);
    }
  });

  router.get('/images/:id', async (c) => {
    const id = c.req.param('id');
    const repo = await images.get(id);
    if (!repo) return c.json(fail('NOT_FOUND', 'ImageRepository not found'), 404);
    return c.json(ok(repo));
  });

  router.put('/images/:id', async (c) => {
    try {
      const id = c.req.param('id');
      const body = await c.req.json<UpdateImageInput>();
      const repo = await images.update(id, body);
      return c.json(ok(repo));
    } catch (e: any) {
      return c.json(fail('UPDATE_FAILED', e.message), e.status ?? 400);
    }
  });

  router.delete('/images/:id', async (c) => {
    try {
      const id = c.req.param('id');
      await images.delete(id);
      return c.json(ok(null));
    } catch (e: any) {
      return c.json(fail('DELETE_FAILED', e.message), e.status ?? 400);
    }
  });

  // ─── Image Pull (async) ───

  router.post('/images/:id/pull', async (c) => {
    try {
      const id = c.req.param('id');
      const repo = await images.get(id);
      if (!repo) return c.json(fail('NOT_FOUND', 'ImageRepository not found'), 404);
      if (repo.status !== 'active') return c.json(fail('INVALID_STATUS', 'ImageRepository is not active'), 400);

      const taskId = `pull_${crypto.randomUUID()}`;
      const task = {
        id: taskId,
        repositoryId: id,
        image: repo.image,
        status: 'pulling' as const,
        createdAt: Date.now(),
      };

      await c.var.stores.atomic.set('pull-task:' + taskId, task, null);
      // Maintain per-repo index for task listing
      const idxKey = 'pull-task:repo:' + id;
      const idxEntry = await c.var.stores.atomic.get<string[]>(idxKey);
      await c.var.stores.atomic.set(idxKey, [...(idxEntry?.value ?? []), taskId], idxEntry?.version ?? null);
      // Enqueue async pull event — pass credentialRef for registry auth
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

  // ─── Pull Task Status ───

  router.get('/pull-tasks/:taskId', async (c) => {
    const taskId = c.req.param('taskId');
    const entry = await c.var.stores.atomic.get<any>('pull-task:' + taskId);
    if (!entry) return c.json(fail('NOT_FOUND', 'Pull task not found'), 404);
    return c.json(ok(entry.value));
  });

  router.get('/images/:id/tasks', async (c) => {
    // List all pull tasks for a repository by scanning the index
    const idx = await c.var.stores.atomic.get<string[]>('pull-task:repo:' + c.req.param('id'));
    if (!idx) return c.json(ok({ items: [], total: 0 }));
    const entries = await Promise.all(idx.value.map((tid: string) => c.var.stores.atomic.get<any>('pull-task:' + tid)));
    const tasks = entries.filter(e => e).map(e => e!.value);
    return c.json(ok({ items: tasks, total: tasks.length }));
  });

  return router;
}

export const topologyRouteMeta: RouteMeta[] = [
  { method: 'GET', path: '/regions', description: '列出已知 region（?platform=alibaba|aws|podman）', responseDescription: '{ platform, regions[] }' },
  { method: 'GET', path: '/buckets', description: '列出 region-scoped 存储桶', responseDescription: '{ items: RegionBucket[] }' },
  { method: 'POST', path: '/buckets', description: '创建 region bucket 记录', responseDescription: 'RegionBucket' },
  { method: 'PUT', path: '/buckets/:id', description: '更新 bucket 记录', responseDescription: 'RegionBucket' },
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
];
