import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInfoHandler, infoRouteMeta } from '../src/features/info/info.handler.ts';
import { createUserRouter, userRouteMeta } from '../src/features/users/handler.ts';
import { createPermissionRouter, permissionRouteMeta } from '../src/features/permission/handler.ts';
import { createSysGroupRouter, sysGroupRouteMeta } from '../src/features/system-group/handler.ts';
import { createTemplateRouter, templateRouteMeta } from '../src/features/template/handler.ts';
import { createImageRouter, imageRouteMeta } from '../src/features/image/handler.ts';
import { createSandboxRouter, sandboxRouteMeta } from '../src/features/sandbox/handler.ts';
import { createPlatformsRouter, platformsRouteMeta } from '../src/features/platforms/handler.ts';
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
  app: ReturnType<typeof createInfoHandler | typeof createUserRouter | typeof createAuditRouter | typeof createPermissionRouter>,
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
collect('img', 'Img', '/api/images', createImageRouter(), () => true, imageRouteMeta);

const stubSandboxSvc: any = { getById: async () => null, stop: async () => {}, terminate: async () => {}, syncRuntime: async () => {}, list: async () => ({ items: [] }) };
collect('sbx', 'Sbx', '/api/sandboxes', createSandboxRouter(stubSandboxSvc as any), () => true, sandboxRouteMeta);

const stubRegistry: any = { availableProviders: () => [{ name: 'stub' }, { name: 'podman' }] };
collect('plf', 'Plf', '/api/platforms', createPlatformsRouter(stubRegistry as any), () => true, platformsRouteMeta);

// Manually-added routes (not in any feature router)
routes.push({
  method: 'POST', path: '/__become-wheel', fileTag: 'auth', tag: 'Dev',
  meta: { method: 'POST', path: '/__become-wheel', description: '将用户加入 simulate_wheel 组（仅 localhost，先 register 拿到 userId）', requestBody: { userId: 'uuid-here' }, responseDescription: '{ success, data }' },
});

// ─── Generate .http files ───

const __dirname = dirname(fileURLToPath(import.meta.url));
const httpDir = resolve(__dirname, '..', 'http');
mkdirSync(httpDir, { recursive: true });

const fileTagOrder = ['info', 'auth', 'sysgrp', 'tpl', 'img', 'sbx', 'plf', 'perm', 'audit', 'users'];
const fileTagTitle: Record<string, string> = {
  info: 'Info',
  auth: 'Auth',
  sysgrp: 'SysGrp',
  tpl: 'Tpl',
  img: 'Img',
  sbx: 'Sbx',
  plf: 'Plf',
  perm: 'Perm',
  audit: 'Audit',
  users: 'Users',
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
