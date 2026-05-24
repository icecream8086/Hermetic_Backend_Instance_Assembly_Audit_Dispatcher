import { Hono } from 'hono';
import type { RouteMeta } from '../../core/http-docs/types.ts';
import type { AppContext } from '../../core/app.ts';
import type { IProviderRegistry } from '../../core/provider/interfaces.ts';
import { ok } from '../../core/response.ts';

export function createPlatformsRouter(registry: IProviderRegistry): Hono<{ Variables: AppContext }> {
  const router = new Hono<{ Variables: AppContext }>();

  router.get('/', async (c) => {
    const platforms = registry.availableProviders().map(p => ({
      name: p.name,
      containerAvailable: true,
    }));
    return c.json(ok(platforms));
  });

  return router;
}

export const platformsRouteMeta: RouteMeta[] = [
  { method: 'GET', path: '/', description: '列出所有可用平台（podman / alibaba / stub）', responseDescription: '{ name }[]' },
];
