import { Hono } from 'hono';
import type { BucketService, InstanceService } from '../../core/region/index.ts';
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
        if (!body.name || !body.platform || !body.accessKeyId || !body.accessKeySecret) {
          return c.json(fail('VALIDATION_ERROR', 'name, platform, accessKeyId, accessKeySecret are required'), 400);
        }
        const cred = await credentials.create(body);
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
];
