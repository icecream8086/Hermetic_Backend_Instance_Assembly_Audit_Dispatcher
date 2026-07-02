/// <reference types="@cloudflare/workers-types" />

import { z } from 'zod';
import { Hono } from 'hono';

/**
 * WebSocket 升级路由
 *
 * 根据 path 将 Upgrade 请求路由到对应的 Durable Object。
 * DO 必须在 wrangler.toml 中绑定并通过 platformBindings 传入。
 *
 * 生产环境（Workers）：  将 Upgrade 请求代理到 DO，由 DO 建立 WebSocket
 * 本地开发（npm run dev）：WebSocket 不可用，返回 501
 */
export function createWsRouter(platformBindings?: Record<string, unknown>): Hono {
  const router = new Hono();

  const notifDO = z.custom<DurableObjectNamespace>().optional().parse(platformBindings?.NOTIFICATION_DO);

  if (!notifDO) {
    // Dev mode: no DO bindings, WebSocket not available
    router.get('/notifications', (c) => {
      return c.json({
        error: 'WEBSOCKET_UNAVAILABLE',
        message: 'WebSocket notifications are not available in this environment',
      }, 501);
    });
    return router;
  }

  router.get('/notifications', async (c) => {
    const stub = notifDO.get(notifDO.idFromName('notif:global'));
    return stub.fetch(c.req.raw);
  });

  return router;
}
