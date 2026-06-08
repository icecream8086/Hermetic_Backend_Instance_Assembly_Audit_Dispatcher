import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInfoHandler, infoRouteMeta } from '../src/features/info/info.handler.ts';
import { createUserRouter, userRouteMeta } from '../src/features/users/handler.ts';
import { createPermissionRouter, permissionRouteMeta } from '../src/features/permission/handler.ts';
import { createSysGroupRouter, sysGroupRouteMeta } from '../src/features/system-group/handler.ts';
import { createTemplateRouter, templateRouteMeta } from '../src/features/template/handler.ts';
import { createSandboxRouter, sandboxRouteMeta } from '../src/features/sandbox/handler.ts';
import { createPlatformsRouter, platformsRouteMeta } from '../src/features/platforms/handler.ts';
import { createNetworkRouter, networkRouteMeta } from '../src/features/network/handler.ts';
import { createTopologyRouter, topologyRouteMeta } from '../src/features/topology/handler.ts';
import { createSubnetRouter, subnetRouteMeta } from '../src/features/subnet/handler.ts';
import { createVolumeRouter, volumeRouteMeta } from '../src/features/volume/handler.ts';
import type { RouteMeta } from '../src/core/http-docs/types.ts';
import { createAuditRouter } from '../src/core/audit/audit-router.ts';
import { WorkersAuditLogger } from '../src/core/audit/workers-audit-logger.ts';

// ─── Route collector ───

interface RouteDoc {
  method: string;
  path: string;
  fileTag: string;
  tag: string;
  meta?: RouteMeta;
}

const routes: RouteDoc[] = [];

function collect(
  fileTag: string,
  label: string,
  basePath: string,
  app: { routes: Array<{ method: string; path: string }> },
  pathFilter: (relPath: string) => boolean,
  metaList?: RouteMeta[],
) {
  for (const r of app.routes) {
    const method = r.method.toUpperCase();
    const relPath = r.path;
    if (!pathFilter(relPath)) continue;
    const absPath = `${basePath}${relPath}`.replace(/\/+/g, '/');
    const meta = metaList?.find(m => m.method === method && m.path === relPath);
    routes.push({ method, path: absPath, fileTag, tag: label, meta });
  }
}

// ─── Audit route meta ───

const auditRouteMeta: RouteMeta[] = [
  {
    method: 'GET',
    path: '/logs',
    description: '查询审计日志（支持翻页，?page=&limit=）',
    responseDescription: '{ page, limit, total, totalPages, lines }',
  },
  {
    method: 'GET',
    path: '/logs/stats',
    description: '审计日志缓冲区统计',
    responseDescription: '{ count, capacity }',
  },
];

// ─── Register handlers ───

// Stub user service — only exposes interface enough to register routes
const stubUserService = {
  register: async () => { throw new Error('stub'); },
  login: async () => { throw new Error('stub'); },
  loginNoPassword: async () => { throw new Error('stub'); },
  getById: async () => null,
  update: async () => { throw new Error('stub'); },
  delete: async () => {},
  list: async () => [],
  validateToken: async () => null,
  clearLoginPolicy: async () => { throw new Error('stub'); },
  clearPublicKey: async () => { throw new Error('stub'); },
  getLoginInfo: async () => ({ exists: false, methods: [] as string[] }),
  refresh: async () => null,
};

const AUTH_PATHS = new Set(['/register', '/login']);

const stubStores = { metrics: { snapshot: () => ({ gets: 0, hits: 0, misses: 0, sets: 0, hitRate: 0 }) } };

const stubPermService = {
  createPolicy: async () => ({ id: '', name: '', effect: 'allow' as const, actions: [], priority: 0, enabled: true, createdAt: 0, updatedAt: 0 }),
  listPolicies: async () => [],
  getPolicy: async () => null,
  updatePolicy: async () => { throw new Error('stub'); },
  deletePolicy: async () => {},
  check: async () => ({ allowed: true, reason: 'stub' }),
};
collect('info', 'Info', '/', createInfoHandler(stubStores as any), () => true, infoRouteMeta);
collect('auth', 'Auth', '/api/users', createUserRouter(stubUserService as any), p => AUTH_PATHS.has(p), userRouteMeta);
collect('users', 'Users', '/api/users', createUserRouter(stubUserService as any), p => !AUTH_PATHS.has(p), userRouteMeta);
collect('audit', 'Audit', '/api/audit', createAuditRouter(new WorkersAuditLogger()), () => true, auditRouteMeta);
collect('perm', 'Perm', '/api/permissions', createPermissionRouter(stubPermService as any), () => true, permissionRouteMeta);

const stubSysGroupService = { create: async () => ({ id: '', name: '', rules: [], priority: 0, createdAt: 0, updatedAt: 0 }), list: async () => [], get: async () => null, update: async () => { throw new Error('stub'); }, delete: async () => {} };
collect('sysgrp', 'SysGrp', '/api/system-groups', createSysGroupRouter(stubSysGroupService as any), () => true, sysGroupRouteMeta);

// Use a plain store object that accepts any key/value (stub for route scanning)
const stubAtomic: any = { get: async () => null, set: async () => null };
collect('tpl', 'Tpl', '/api/templates', createTemplateRouter(stubAtomic as any), () => true, templateRouteMeta);

const stubSandboxSvc: any = { getById: async () => null, stop: async () => {}, terminate: async () => {}, syncRuntime: async () => {}, list: async () => ({ items: [] }) };
collect('sbx', 'Sbx', '/api/sandboxes', createSandboxRouter(stubSandboxSvc as any), () => true, sandboxRouteMeta);

const stubVolumeSvc: any = { create: async () => ({}), get: async () => null, listPaginated: async () => ({ items: [], total: 0, page: 1, limit: 50 }), update: async () => ({}), delete: async () => {} };
collect('vol', 'Vol', '/api/volumes', createVolumeRouter(stubVolumeSvc), () => true, volumeRouteMeta);

const stubRegistry: any = { availableProviders: () => [{ name: 'stub' }, { name: 'podman' }] };
collect('plf', 'Plf', '/api/platforms', createPlatformsRouter(stubRegistry as any), () => true, platformsRouteMeta);
collect('net', 'Net', '/api/networks', createNetworkRouter({
  create: async () => ({} as any),
  list: async () => ({ items: [], total: 0, page: 1, limit: 20 }),
  get: async () => null,
  update: async () => ({} as any),
  delete: async () => {},
}), () => true, networkRouteMeta);

const stubSubnetSvc: any = { create: async () => ({}), list: async () => ({ items: [], total: 0, page: 1, limit: 20 }), get: async () => null, update: async () => ({}), delete: async () => {} };
collect('sub', 'Sub', '/api/subnets', createSubnetRouter(stubSubnetSvc), () => true, subnetRouteMeta);

const stubClusterSvc: any = { create: async () => ({}), get: async () => null, list: async () => [], update: async () => ({}), delete: async () => {} };
const stubBucketSvc: any = { create: async () => ({}), get: async () => null, list: async () => [], update: async () => ({}), delete: async () => {} };
const stubImageSvc: any = { create: async () => ({}), get: async () => null, list: async () => [], update: async () => ({}), delete: async () => {} };
const stubPolicyMgr: any = { list: async () => [], create: async () => ({}), get: async () => null, update: async () => ({}), delete: async () => {} };
collect('topo', 'Topo', '/api/topology', createTopologyRouter(stubClusterSvc, stubBucketSvc, stubImageSvc, undefined, stubPolicyMgr), () => true, topologyRouteMeta);

// Manually-added routes (not in any feature router)
routes.push({
  method: 'POST', path: '/__tick', fileTag: 'events', tag: 'Dev',
  meta: { method: 'POST', path: '/__tick', description: '[DEV] 手动触发事件循环 tick', responseDescription: '{ ok, queueSize, processedCount, running }' },
});
// Log stream WebSocket (route registered in app.ts, not in sandbox handler)
routes.push({
  method: 'GET', path: '/api/sandboxes/:id/logs', fileTag: 'sbx', tag: 'Sandbox',
  meta: { method: 'GET', path: '/:id/logs', description: 'WebSocket 实时容器日志流 — 支持 ?tail=N&since=ts', responseDescription: 'WebSocket stream (升级后持续推送日志行 / JSON 事件)' },
});
routes.push({
  method: 'POST', path: '/__admin/migrate-user-index', fileTag: 'users', tag: 'Dev',
  meta: { method: 'POST', path: '/__admin/migrate-user-index', description: '[DEV] 重建分片用户索引', requestBody: { ids: ['uuid-1', 'uuid-2'] }, responseDescription: '{ migrated: number }' },
});
// Public
routes.push({
  method: 'GET', path: '/api/openapi.json', fileTag: 'info', tag: 'Public',
  meta: { method: 'GET', path: '/api/openapi.json', description: 'OpenAPI 3.0 规范（无需认证）', responseDescription: 'OpenAPI 3.0 JSON' },
});
// WebSocket notifications
routes.push({
  method: 'GET', path: '/api/ws/notifications', fileTag: 'info', tag: 'Notifications',
  meta: { method: 'GET', path: '/api/ws/notifications', description: 'WebSocket 升级到全局通知频道（需要 Workers 部署 + DO 绑定）', responseDescription: '101 WebSocket Upgrade' },
});
// Event bus
const eventMetas: RouteMeta[] = [
  { method: 'POST', path: '/', description: '入队一个事件', requestBody: { type: 'my-event', payload: {} }, responseDescription: '{ id }' },
  { method: 'GET', path: '/loop/status', description: '事件循环状态', responseDescription: 'EventLoopStatus' },
  { method: 'POST', path: '/loop/start', description: '启动事件循环', responseDescription: '{ ok }' },
  { method: 'POST', path: '/loop/stop', description: '停止事件循环', responseDescription: '{ ok }' },
  { method: 'POST', path: '/loop/pause', description: '暂停事件循环', responseDescription: '{ ok }' },
  { method: 'POST', path: '/loop/resume', description: '恢复事件循环', responseDescription: '{ ok }' },
  { method: 'POST', path: '/loop/configure', description: '重新配置事件循环', requestBody: { intervalMs: 5000 }, responseDescription: 'EventLoopConfig' },
];
for (const m of eventMetas) {
  routes.push({ method: m.method, path: `/api/events${m.path}`, fileTag: 'events', tag: 'Events', meta: m });
}

// Sudo
routes.push({
  method: 'POST', path: '/api/sudo', fileTag: 'auth', tag: 'Dev',
  meta: { method: 'POST', path: '/api/sudo', description: '[DEV] 临时提权 — wheel 组成员调用后获得 30 分钟管理员权限', requestBody: {}, responseDescription: '{ expiry, durationMs }' },
});

// ─── Generate .http files ───

const __dirname = dirname(fileURLToPath(import.meta.url));
const httpDir = resolve(__dirname, '..', 'http');
mkdirSync(httpDir, { recursive: true });

const fileTagOrder = ['info', 'auth', 'sysgrp', 'tpl', 'sbx', 'vol', 'plf', 'perm', 'audit', 'users', 'events', 'topo', 'sub'];
const fileTagTitle: Record<string, string> = {
  info: 'Info',
  auth: 'Auth',
  sysgrp: 'SysGrp',
  tpl: 'Tpl',
  sbx: 'Sbx',
  vol: 'Vol',
  plf: 'Plf',
  perm: 'Perm',
  audit: 'Audit',
  users: 'Users',
  events: 'Events',
  topo: 'Topo',
  sub: 'Sub',
};

for (const ft of fileTagOrder) {
  const group = routes.filter(r => r.fileTag === ft);
  if (group.length === 0) continue;

  const hasVarId = group.some(r => r.path.includes(':id'));
  const lines: string[] = [
    `# HBI-AAD — ${fileTagTitle[ft]} Endpoints (auto-generated by scripts/export-http.ts)`,
    '',
    '@baseUrl = http://localhost:3000',
    '# 通过 auth.http 的 POST /register 或 POST /login 获取 token，填到下面',
    '@token = your-token-here',
    ...(hasVarId ? ['', '# 注册后把返回的 userId 填到下面', '@userId = 00000000-0000-0000-0000-000000000000'] : []),
    '',
  ];

  let currentTag = '';
  for (const route of group) {
    if (route.tag !== currentTag) {
      currentTag = route.tag;
      lines.push('');
      lines.push(`# ─── ${route.tag} ───`);
      lines.push('');
    }

    const { method, path, meta } = route;

    lines.push(`### ${method} ${path}${meta?.description ? ` — ${meta.description}` : ''}`);

    if (meta?.responseDescription) {
      lines.push(`# Response: ${meta.responseDescription}`);
    }

    const baseUrl = path.replace(/:id\b/g, '{{userId}}');
    if (meta?.queryExamples) {
      const firstQs = new URLSearchParams(meta.queryExamples[0]).toString();
      lines.push(`${method} {{baseUrl}}${baseUrl}?${firstQs}`);
      for (let i = 1; i < meta.queryExamples.length; i++) {
        const qs = new URLSearchParams(meta.queryExamples[i]).toString();
        lines.push(`# ${method} {{baseUrl}}${baseUrl}?${qs}`);
      }
    } else {
      lines.push(`${method} {{baseUrl}}${baseUrl}`);
    }

    lines.push('Authorization: Bearer {{token}}');

    if (meta?.requestBody && !['GET', 'DELETE'].includes(method)) {
      lines.push('Content-Type: application/json');
      lines.push('');
      lines.push(JSON.stringify(meta.requestBody, null, 2));
    }

    lines.push('');
  }

  const content = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  const fileName = resolve(httpDir, `${ft}.http`);
  writeFileSync(fileName, content, 'utf-8');
  console.log(`✓ Generated ${fileName} (${group.length} routes)`);
}
