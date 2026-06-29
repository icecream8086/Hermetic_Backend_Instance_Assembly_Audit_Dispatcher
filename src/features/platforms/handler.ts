import { Hono } from 'hono';
import type { RouteMeta } from '../../core/http-docs/types.ts';
import type { AppContext } from '../../core/deps.ts';
import type { IProviderRegistry } from '../../core/provider/interfaces.ts';
import type { IAtomicStore } from '../../core/store/interfaces.ts';
import { InstanceService } from '../../core/region/instance.ts';
import { ALIBABA_REGIONS } from '../../core/region/types.ts';
import { getExtensionSchema } from '../../core/provider/extension-schema.ts';
import { ok, fail } from '../../core/response.ts';

export function createPlatformsRouter(
  registry: IProviderRegistry,
  atomicStore?: IAtomicStore,
): Hono<{ Variables: AppContext }> {
  const router = new Hono<{ Variables: AppContext }>();

  // eslint-disable-next-line @typescript-eslint/require-await -- interface contract requires Promise<T>
  router.get('/', async (c) => {
    const page = parseInt(c.req.query('page') ?? '') || 1;
    const limit = parseInt(c.req.query('limit') ?? '') || 50;
    const platforms = registry.availableProviders().map(p => ({
      name: p.name,
      containerAvailable: true,
    }));
    const total = platforms.length;
    const start = (page - 1) * limit;
    return c.json(ok({ items: platforms.slice(start, start + limit), total, page, limit }));
  });

  /**
   * GET /extension-fields?instanceId=xxx
   *
   * Returns the available extension field definitions for the compute instance's provider.
   * The frontend uses this to render dynamic forms for provider-specific parameters.
   */
  router.get('/extension-fields', async (c) => {
    const instanceId = c.req.query('instanceId');
    if (!instanceId) return c.json(fail('VALIDATION_ERROR', 'instanceId is required'), 400);

    if (!atomicStore) return c.json(fail('SERVICE_UNAVAILABLE', 'Atomic store not available'), 503);

    const instSvc = new InstanceService(atomicStore);
    const inst = await instSvc.get(instanceId as any);
    if (!inst) return c.json(fail('NOT_FOUND', 'Compute instance not found'), 404);

    const schema = getExtensionSchema(inst.platform);
    if (!schema) {
      return c.json(ok({ provider: inst.platform, label: inst.platform, instanceId: inst.id, instanceName: inst.name, fields: [] }));
    }

    return c.json(ok({
      provider: schema.provider,
      label: schema.label,
      instanceId: inst.id,
      instanceName: inst.name,
      fields: schema.fields,
    }));
  });

  /**
   * GET /regions?platform=alibaba
   * GET /regions?instanceId=xxx
   *
   * Returns available regions for a platform.
   * - ?platform=: 直接按平台查（无实例时用，鸡和蛋问题）
   * - ?instanceId=: 通过已有实例的凭证实时拉取
   */
  router.get('/regions', async (c) => {
    const platform = c.req.query('platform');
    const instanceId = c.req.query('instanceId');

    if (!platform && !instanceId) {
      return c.json(fail('VALIDATION_ERROR', 'Either platform or instanceId is required'), 400);
    }

    let resolvedPlatform = platform ?? '';
    let regions: readonly any[] | undefined;

    // ─── Path A: resolve via instanceId (has credentials for live API call) ───
    if (instanceId) {
      if (!atomicStore) return c.json(fail('SERVICE_UNAVAILABLE', 'Atomic store not available'), 503);
      const instSvc = new InstanceService(atomicStore);
      const inst = await instSvc.get(instanceId as any);
      if (!inst) return c.json(fail('NOT_FOUND', 'Compute instance not found'), 404);
      resolvedPlatform = inst.platform;

      switch (inst.platform) {
        case 'alibaba': {
          const client = await registry.resolveRawEciApi(instanceId as any);
          if (client) regions = await client.describeRegions();
          break;
        }
        case 'podman':
          regions = [{ regionId: 'local', endpoints: [{ endpoint: inst.endpoint }] }];
          break;
        case 'aws':
        case 'stub':
          // No live API — fall through to static region list
          break;
      }
    }

    // ─── Path B: static fallback (no instance or live API failed) ───
    if (!regions?.length) {
      switch (resolvedPlatform) {
        case 'alibaba':
          regions = ALIBABA_REGIONS.map(r => ({ RegionId: r }));
          break;
        case 'podman':
          regions = [{ regionId: 'local' }];
          break;
        default:
          regions = [];
      }
    }

    return c.json(ok({ platform: resolvedPlatform, regions }));
  });

  return router;
}

export const platformsRouteMeta: RouteMeta[] = [
  { method: 'GET', path: '/', description: '列出所有可用平台（podman / alibaba / stub）', responseDescription: '{ name }[]' },
  { method: 'GET', path: '/extension-fields', description: '获取指定计算实例的可用扩展字段（?instanceId=）', responseDescription: '{ provider, label, fields }' },
  { method: 'GET', path: '/regions', description: '获取实例所属平台的可选地域列表（?instanceId=），Alibaba ECI 从 DescribeRegions 实时拉取', responseDescription: '{ regions[] }' },
];
