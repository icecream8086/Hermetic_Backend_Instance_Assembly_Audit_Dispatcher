/**
 * Generate OpenAPI 3.0 specification from Hono route metadata.
 *
 * Usage: npx tsx scripts/export-openapi.ts
 * Output: openapi.json (in project root)
 *
 * The generated spec can be consumed by openapi-generator or
 * swagger-ui for frontend code generation and API exploration.
 */

import { writeFileSync } from 'node:fs';
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
import type { RouteMeta } from '../src/core/http-docs/types.ts';
import { createAuditRouter } from '../src/core/audit/audit-router.ts';
import { WorkersAuditLogger } from '../src/core/audit/workers-audit-logger.ts';

// ─── Helpers ───

type OpenApiPathItem = Record<string, unknown>;
type OpenApiSpec = {
  openapi: string;
  info: { title: string; version: string; description: string };
  servers: { url: string; description: string }[];
  paths: Record<string, OpenApiPathItem>;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
  tags: { name: string; description: string }[];
};

/** Infer a rough JSON Schema type from a requestBody example value. */
function inferSchema(example: unknown): Record<string, unknown> {
  if (example === null) return { type: 'null' };
  if (Array.isArray(example)) {
    return {
      type: 'array',
      items: example.length > 0 ? inferSchema(example[0]) : { type: 'object' },
    };
  }
  const t = typeof example;
  if (t === 'string') return { type: 'string' };
  if (t === 'number') return { type: 'number' };
  if (t === 'boolean') return { type: 'boolean' };
  if (t === 'object') {
    const props: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(example as Record<string, unknown>)) {
      props[k] = inferSchema(v);
      if (v !== undefined && v !== null && !String(k).endsWith('?')) required.push(k);
    }
    const schema: Record<string, unknown> = { type: 'object', properties: props };
    if (required.length > 0) schema.required = required;
    return schema;
  }
  return {};
}

/** Convert an HTTP path with :param placeholders to OpenAPI {param} syntax. */
function toOpenApiPath(path: string): string {
  return path.replace(/:(\w+)/g, '{$1}');
}

/** Capitalize a tag name. */
function tagLabel(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// ─── Build spec ───

const spec: OpenApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'HBI-AAD API',
    version: '4.0.0',
    description: 'Hermetic Backend Instance Assembly Audit Dispatcher — Cloudflare Workers based game server sandbox orchestration API.\n\nAuthentication: Bearer token obtained via `POST /api/users/register` or `POST /api/users/login`.\n\nAll API endpoints are prefixed with `/api/` except the info endpoint.',
  },
  servers: [
    { url: 'http://localhost:3000', description: 'Local development' },
    { url: 'https://hbi-aad.example.com', description: 'Production' },
  ],
  paths: {},
  components: {
    schemas: {},
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'UUID',
        description: 'Session token from POST /api/users/register or /api/users/login',
      },
    },
  },
  tags: [],
};

const tagSet = new Set<string>();

// ─── Router registration ───

interface RouteDoc {
  method: string;
  path: string;
  tag: string;
  meta?: RouteMeta;
}

const routes: RouteDoc[] = [];

function collect(
  label: string,
  basePath: string,
  app: { routes: Array<{ method: string; path: string }> },
  metaList?: RouteMeta[],
) {
  for (const r of app.routes) {
    const method = r.method.toUpperCase();
    const relPath = r.path;
    const absPath = `${basePath}${relPath}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    const meta = metaList?.find(m => m.method === method && m.path === relPath);
    routes.push({ method, path: absPath, tag: label, meta });
    tagSet.add(label);
  }
}

const auditRouteMeta: RouteMeta[] = [
  { method: 'GET', path: '/logs', description: '查询审计日志（支持翻页）', responseDescription: '{ page, limit, total, totalPages, lines }' },
  { method: 'GET', path: '/logs/stats', description: '审计日志缓冲区统计', responseDescription: '{ count, capacity }' },
];

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
const stubSysGroupService = { create: async () => ({ id: '', name: '', rules: [], priority: 0, createdAt: 0, updatedAt: 0 }), list: async () => [], get: async () => null, update: async () => { throw new Error('stub'); }, delete: async () => {} };
const stubAtomic: any = { get: async () => null, set: async () => null };
const stubSandboxSvc: any = { getById: async () => null, stop: async () => {}, terminate: async () => {}, syncRuntime: async () => {}, list: async () => ({ items: [] }) };
const stubRegistry: any = { availableProviders: () => [{ name: 'stub' }, { name: 'podman' }] };

collect('Info', '/', createInfoHandler(stubStores as any), infoRouteMeta);
collect('Auth', '/api/users', createUserRouter(stubUserService as any), userRouteMeta?.filter(m => AUTH_PATHS.has(m.path)));
collect('Users', '/api/users', createUserRouter(stubUserService as any), userRouteMeta?.filter(m => !AUTH_PATHS.has(m.path)));
collect('Audit', '/api/audit', createAuditRouter(new WorkersAuditLogger()), auditRouteMeta);
collect('Permissions', '/api/permissions', createPermissionRouter(stubPermService as any), permissionRouteMeta);
collect('System Groups', '/api/system-groups', createSysGroupRouter(stubSysGroupService as any), sysGroupRouteMeta);
collect('Templates', '/api/templates', createTemplateRouter(stubAtomic as any), templateRouteMeta);
collect('Sandboxes', '/api/sandboxes', createSandboxRouter(stubSandboxSvc as any), sandboxRouteMeta);
collect('Platforms', '/api/platforms', createPlatformsRouter(stubRegistry as any), platformsRouteMeta);
collect('Networks', '/api/networks', createNetworkRouter({
  create: async () => ({} as any),
  list: async () => ({ items: [], total: 0, page: 1, limit: 20 }),
  get: async () => null,
  update: async () => ({} as any),
  delete: async () => {},
}), networkRouteMeta);

const stubSubnetSvc: any = { create: async () => ({}), list: async () => ({ items: [], total: 0, page: 1, limit: 20 }), get: async () => null, update: async () => ({}), delete: async () => {} };
collect('Subnets', '/api/subnets', createSubnetRouter(stubSubnetSvc), subnetRouteMeta);

const stubClusterSvc: any = { create: async () => ({}), get: async () => null, list: async () => [], update: async () => ({}), delete: async () => {} };
const stubBucketSvc: any = { create: async () => ({}), get: async () => null, list: async () => [], update: async () => ({}), delete: async () => {} };
const stubImageSvc: any = { create: async () => ({}), get: async () => null, list: async () => [], update: async () => ({}), delete: async () => {} };
collect('Topology', '/api/topology', createTopologyRouter(stubClusterSvc, stubBucketSvc, stubImageSvc), topologyRouteMeta);

// Manually-added routes
function addRoute(method: string, path: string, tag: string, meta?: RouteMeta) {
  routes.push({ method, path, tag, meta });
  tagSet.add(tag);
}
addRoute('POST', '/__tick', 'Dev', { method: 'POST', path: '/__tick', description: 'Manually trigger event loop tick', responseDescription: '{ ok, queueSize, processedCount, running }' });
addRoute('POST', '/__admin/migrate-user-index', 'Dev', { method: 'POST', path: '/__admin/migrate-user-index', description: 'Rebuild sharded user index', requestBody: { ids: ['uuid-1'] }, responseDescription: '{ migrated: number }' });
addRoute('GET', '/api/openapi.json', 'Public', { method: 'GET', path: '/api/openapi.json', description: 'OpenAPI 3.0 specification (no auth required)', responseDescription: 'OpenAPI 3.0 JSON' });
addRoute('GET', '/api/ws/notifications', 'Notifications', { method: 'GET', path: '/api/ws/notifications', description: 'WebSocket upgrade to global notification channel (requires Workers deployment with DO binding)', responseDescription: '101 WebSocket upgrade' });
addRoute('POST', '/api/events', 'Events', { method: 'POST', path: '/', description: 'Enqueue an event', requestBody: { type: 'my-event', payload: {} }, responseDescription: '{ id }' });
addRoute('GET', '/api/events/loop/status', 'Events', { method: 'GET', path: '/loop/status', description: 'Event loop status', responseDescription: 'EventLoopStatus' });
addRoute('POST', '/api/events/loop/start', 'Events', { method: 'POST', path: '/loop/start', description: 'Start event loop', responseDescription: '{ ok }' });
addRoute('POST', '/api/events/loop/stop', 'Events', { method: 'POST', path: '/loop/stop', description: 'Stop event loop', responseDescription: '{ ok }' });
addRoute('POST', '/api/events/loop/pause', 'Events', { method: 'POST', path: '/loop/pause', description: 'Pause event loop', responseDescription: '{ ok }' });
addRoute('POST', '/api/events/loop/resume', 'Events', { method: 'POST', path: '/loop/resume', description: 'Resume event loop', responseDescription: '{ ok }' });
addRoute('POST', '/api/events/loop/configure', 'Events', { method: 'POST', path: '/loop/configure', description: 'Reconfigure event loop', requestBody: { intervalMs: 5000 }, responseDescription: 'EventLoopConfig' });

// Dev / Sudo
addRoute('POST', '/api/sudo', 'Dev', { method: 'POST', path: '/api/sudo', description: '[DEV] Temporary privilege elevation for wheel members (30 min)', requestBody: {}, responseDescription: '{ expiry, durationMs }' });

// ─── Convert routes to OpenAPI paths ───

for (const route of routes) {
  const openApiPath = toOpenApiPath(route.path);
  if (!spec.paths[openApiPath]) spec.paths[openApiPath] = {};

  const method = route.method.toLowerCase();
  const meta = route.meta;

  const operation: Record<string, unknown> = {
    tags: [route.tag],
    summary: meta?.description ?? `${route.method} ${route.path}`,
    description: meta?.description ?? '',
    parameters: [],
    responses: {
      '200': {
        description: meta?.responseDescription ?? 'Success',
        content: { 'application/json': { schema: { type: 'object' } } },
      },
    },
  };

  // Extract path parameters
  const pathParams = [...route.path.matchAll(/:(\w+)/g)].map(m => m[1]);
  for (const pp of pathParams) {
    (operation.parameters as unknown[]).push({
      name: pp,
      in: 'path',
      required: true,
      schema: { type: 'string' },
      description: pp,
    });
  }

  // Add requestBody for POST/PUT with examples
  if (meta?.requestBody && !['GET', 'DELETE'].includes(route.method)) {
    operation.requestBody = {
      required: true,
      content: {
        'application/json': {
          schema: inferSchema(meta.requestBody),
          example: meta.requestBody,
        },
      },
    };
    operation['x-example-body'] = JSON.stringify(meta.requestBody, null, 2);
  }

  // Error responses
  if (!(operation.responses as Record<string, unknown>)['400']) {
    (operation.responses as Record<string, unknown>)['400'] = { description: 'Validation error' };
  }
  if (!(operation.responses as Record<string, unknown>)['403']) {
    (operation.responses as Record<string, unknown>)['403'] = { description: 'Forbidden / authentication required' };
  }
  if (!(operation.responses as Record<string, unknown>)['500']) {
    (operation.responses as Record<string, unknown>)['500'] = { description: 'Internal server error' };
  }

  // Security: all /api/ routes require bearer auth except auth endpoints
  if (route.path.startsWith('/api/')) {
    operation.security = [{ bearerAuth: [] }];
  }

  (spec.paths[openApiPath] as Record<string, unknown>)[method] = operation;
}

// ─── Tags ───

spec.tags = [...tagSet].map(name => ({
  name,
  description: `${tagLabel(name)} API endpoints`,
}));

// ─── Write output ───

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(__dirname, '..', 'openapi.json');
writeFileSync(outputPath, JSON.stringify(spec, null, 2), 'utf-8');
console.log(`✓ Generated ${outputPath} (${routes.length} routes, ${Object.keys(spec.paths).length} paths)`);

// ─── Also export a summary ───

const summary = {
  totalRoutes: routes.length,
  totalPaths: Object.keys(spec.paths).length,
  tags: spec.tags.map(t => t.name),
  endpoints: routes.map(r => `${r.method} ${r.path}`),
};

const summaryPath = resolve(__dirname, '..', 'openapi-summary.json');
writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
console.log(`✓ Generated ${summaryPath}`);
