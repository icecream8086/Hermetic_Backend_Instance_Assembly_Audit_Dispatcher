import { z } from 'zod';
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { ServerInfoSchema } from './info.schema.ts';
import type { Stores } from '../../core/store/interfaces.ts';
import { ok } from '../../core/response.ts';

const START_TIME = Date.now();

const InfoResponseSchema = z.object({
  success: z.literal(true),
  data: ServerInfoSchema,
  error: z.null(),
});

const route = createRoute({
  method: 'get',
  path: '/info',
  summary: '返回服务器基本信息',
  description: '返回服务器基本信息（名称、版本、已开启功能、运行时长、缓存命中率）',
  responses: {
    200: {
      content: { 'application/json': { schema: InfoResponseSchema } },
      description: 'ServerInfo — name, version, platform, features, uptime, storeMetrics',
    },
  },
  tags: ['info'],
});

export function createInfoHandler(stores: Stores): OpenAPIHono {
  const app = new OpenAPIHono();

  app.openapi(route, (c) => {
    const stats = stores.metrics.snapshot();
    const info = {
      name: 'HBI-AAD',
      description: 'Hermetic Backend Instance Assembly Audit Dispatcher — sandbox lifecycle management for game server fleets.',
      version: '4.0.0',
      platform: 'cloudflare-workers',
      region: process.env.CF_REGION ?? 'auto',
      features: { sandbox: true, assembly: true, audit: true } as Record<string, boolean>,
      uptime: Date.now() - START_TIME,
      storeMetrics: stats,
    };
    return c.json(ok(info));
  });

  return app;
}
