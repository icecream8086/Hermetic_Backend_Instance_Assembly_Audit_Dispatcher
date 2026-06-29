import { z } from 'zod';
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { AppError } from '../../core/types.ts';

import type { IProviderRegistry } from '../../core/provider/interfaces.ts';
import type { IAtomicStore } from '../../core/store/interfaces.ts';
import { InstanceService } from '../../core/region/instance.ts';
import { ALIBABA_REGIONS } from '../../core/region/types.ts';
import { getExtensionSchema } from '../../core/provider/extension-schema.ts';
import { ok } from '../../core/response.ts';

export function createPlatformsRouter(
  registry: IProviderRegistry,
  atomicStore?: IAtomicStore,
): OpenAPIHono {
  const app = new OpenAPIHono();

  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['platforms'],
      summary: '列出所有可用平台',
      responses: { 200: { description: '{ name }[]', content: { 'application/json': { schema: z.any() } } } },
    }),
    // eslint-disable-next-line @typescript-eslint/require-await
    async (c) => {
      const page = parseInt(c.req.query('page') ?? '') || 1;
      const limit = parseInt(c.req.query('limit') ?? '') || 50;
      const platforms = registry.availableProviders().map(p => ({
        name: p.name,
        containerAvailable: true,
      }));
      const total = platforms.length;
      const start = (page - 1) * limit;
      return c.json(ok({ items: platforms.slice(start, start + limit), total, page, limit }));
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/extension-fields',
      tags: ['platforms'],
      summary: '获取指定计算实例的可用扩展字段',
      responses: { 200: { description: '{ provider, label, fields }', content: { 'application/json': { schema: z.any() } } } },
    }),
    async (c) => {
      const instanceId = c.req.query('instanceId');
      if (!instanceId) throw new AppError(400, 'VALIDATION_ERROR', 'instanceId is required');

      if (!atomicStore) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Atomic store not available');

      const instSvc = new InstanceService(atomicStore);
      const inst = await instSvc.get(instanceId as any);
      if (!inst) throw new AppError(404, 'NOT_FOUND', 'Compute instance not found');

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
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/regions',
      tags: ['platforms'],
      summary: '获取实例所属平台的可选地域列表',
      responses: { 200: { description: '{ regions[] }', content: { 'application/json': { schema: z.any() } } } },
    }),
    async (c) => {
      const platform = c.req.query('platform');
      const instanceId = c.req.query('instanceId');

      if (!platform && !instanceId) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Either platform or instanceId is required');
      }

      let resolvedPlatform = platform ?? '';
      let regions: readonly any[] | undefined;

      if (instanceId) {
        if (!atomicStore) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Atomic store not available');
        const instSvc = new InstanceService(atomicStore);
        const inst = await instSvc.get(instanceId as any);
        if (!inst) throw new AppError(404, 'NOT_FOUND', 'Compute instance not found');
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
            break;
        }
      }

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
    },
  );

  return app;
}
