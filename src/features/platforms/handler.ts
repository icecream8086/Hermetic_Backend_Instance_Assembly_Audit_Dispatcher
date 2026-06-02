import { Hono } from 'hono';
import type { RouteMeta } from '../../core/http-docs/types.ts';
import type { AppContext } from '../../core/app.ts';
import type { IProviderRegistry } from '../../core/provider/interfaces.ts';
import { ok } from '../../core/response.ts';

export function createPlatformsRouter(registry: IProviderRegistry): Hono<{ Variables: AppContext }> {
  const router = new Hono<{ Variables: AppContext }>();

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

  return router;
}

export const platformsRouteMeta: RouteMeta[] = [
  { method: 'GET', path: '/', description: '列出所有可用平台（podman / alibaba / stub）', responseDescription: '{ name }[]' },
];
