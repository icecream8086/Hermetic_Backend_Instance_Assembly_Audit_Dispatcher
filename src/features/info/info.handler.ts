import { Hono } from 'hono';
import type { ServerInfo } from './info.schema.ts';
import type { RouteMeta } from '../../core/http-docs/types.ts';

const START_TIME = Date.now();

export function createInfoHandler(): Hono {
  const app = new Hono();

  app.get('/info', (c) => {
    const info: ServerInfo = {
      name: 'HBI-AAD',
      description: 'Hermetic Backend Instance Assembly Audit Dispatcher — sandbox lifecycle management for game server fleets.',
      version: '4.0.0',
      platform: 'cloudflare-workers',
      region: process.env['CF_REGION'] ?? 'auto',
      features: {
        sandbox: true,
        assembly: true,
        audit: true,
      },
      uptime: Date.now() - START_TIME,
    };
    return c.json(info);
  });

  return app;
}

export const infoRouteMeta: RouteMeta[] = [
  {
    method: 'GET',
    path: '/info',
    description: '返回服务器基本信息（名称、版本、已开启功能、运行时长）',
    responseDescription: 'ServerInfo — name, version, platform, features, uptime',
  },
];
