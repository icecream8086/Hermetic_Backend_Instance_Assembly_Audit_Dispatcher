/**
 * Generate OpenAPI 3.0 specification from Hono route metadata.
 * Uses @hono/zod-openapi's built-in getOpenAPIDocument() to extract
 * full Zod schemas instead of empty { type: 'object' } shells.
 *
 * Usage: npx tsx scripts/export-openapi.ts
 * Output: openapi.json (in project root)
 */

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { OpenAPIObject } from 'openapi3-ts/oas30';

import { createInfoHandler } from '../src/features/info/info.handler.ts';
import { createUserRouter } from '../src/features/users/handler.ts';
import { createPermissionRouter } from '../src/features/permission/handler.ts';
import { createSysGroupRouter } from '../src/features/system-group/handler.ts';
import { createTemplateRouter } from '../src/features/template/handler.ts';
import { createPodRouter } from '../src/features/pod/handler.ts';
import { createPlatformsRouter } from '../src/features/platforms/handler.ts';
import { createSecurityGroupRouter } from '../src/features/network/handler.ts';
import { createTopologyRouter } from '../src/features/topology/handler.ts';
import { createSubnetRouter } from '../src/features/subnet/handler.ts';
import { createVolumeRouter } from '../src/features/volume/handler.ts';
import { createImagesRouter } from '../src/features/images/handler.ts';
import { createActionsRouter } from '../src/features/actions/handler.ts';
import { createStorageRouter } from '../src/features/storage/handler.ts';
import { createContainerSecretRouter } from '../src/features/container-secret/handler.ts';
import { createInstancesRouter } from '../src/features/instances/handler.ts';
import { createSecurityRouter } from '../src/features/security/handler.ts';
import { createAuditRouter } from '../src/core/audit/audit-router.ts';
import { WorkersAuditLogger } from '../src/core/audit/workers-audit-logger.ts';

/** Convert Hono :param to OpenAPI {param} syntax. */
function toOpenApiPath(path: string): string {
  return path.replace(/:(\w+)/g, '{$1}');
}

// ─── Stub services (needed for handler factory init, not executed) ───

const stubUserService: any = {
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
const stubStores: any = { metrics: { snapshot: () => ({ gets: 0, hits: 0, misses: 0, sets: 0, hitRate: 0 }) } };
const stubPermService: any = {
  createPolicy: async () => ({}), listPolicies: async () => [], getPolicy: async () => null,
  updatePolicy: async () => { throw new Error('stub'); }, deletePolicy: async () => {},
  check: async () => ({ allowed: true, reason: 'stub' }),
};
const stubSysGroupService: any = { create: async () => ({}), list: async () => [], get: async () => null, update: async () => { throw new Error('stub'); }, delete: async () => {} };
const stubAtomic: any = { get: async () => null, set: async () => null };
const stubPodSvc: any = { getById: async () => null, provision: async () => ({}), stop: async () => ({}), terminate: async () => {}, syncRuntime: async () => ({}), start: async () => ({}), restart: async () => ({}), getHealth: async () => [], getLogs: async () => ({}), exec: async () => ({}), update: async () => ({}), list: async () => ({ items: [] }), getAllIds: async () => [] };
const stubVolumeSvc: any = { create: async () => ({}), get: async () => null, listPaginated: async () => ({ items: [], total: 0, page: 1, limit: 50 }), update: async () => ({}), delete: async () => {} };
const stubRegistry: any = { availableProviders: () => [{ name: 'stub' }, { name: 'podman' }] };
const stubNetworkSvc: any = { create: async () => ({} as any), list: async () => ({ items: [], total: 0, page: 1, limit: 20 }), get: async () => null, update: async () => ({} as any), delete: async () => {} };
const stubSubnetSvc: any = { create: async () => ({}), list: async () => ({ items: [], total: 0, page: 1, limit: 20 }), get: async () => null, update: async () => ({}), delete: async () => {} };
const stubClusterSvc: any = { create: async () => ({}), get: async () => null, list: async () => [], update: async () => ({}), delete: async () => {} };
const stubBucketSvc: any = { create: async () => ({}), get: async () => null, list: async () => [], update: async () => ({}), delete: async () => {} };
const stubImageSvc: any = { create: async () => ({}), get: async () => null, list: async () => [], update: async () => ({}), delete: async () => {} };
const stubPolicyMgr: any = { list: async () => [], create: async () => ({}), get: async () => null, update: async () => ({}), delete: async () => {} };
const stubImageProvider: any = { list: async () => [], inspect: async () => null, pull: async () => ({}), remove: async () => {}, tag: async () => {}, search: async () => [], prune: async () => ({}), history: async () => [], build: async () => ({}) };
const stubProvidersRegistry: any = { image: stubImageProvider, resolveImage: async () => stubImageProvider };
const stubContainerSecretSvc: any = { create: async () => ({}), get: async () => null, list: async () => [], update: async () => ({}), delete: async () => {}, uploadBlob: async () => ({}), resolveData: async () => '' };
const stubSecuritySvc: any = { provision: async () => ({}), list: async () => [], getById: async () => null, revoke: async () => {}, delete: async () => {}, getByBucketId: async () => null };
const stubS3Resolver: any = async () => ({ provider: { getPresignedUrl: async () => '', putPresignedUrl: async () => '', listObjects: async () => ({}) }, bucket: { name: '', endpoint: '', region: '' } });
const stubInstancesSvc: any = { register: async () => ({ runner: {}, token: '' }), list: async () => [], get: async () => null, update: async () => ({}), delete: async () => {}, heartbeat: async () => ({}), markStaleOffline: async () => 0, createRegistrationToken: async () => ({}), validateRegistrationToken: async () => ({ valid: true }), createGroup: async () => ({}), listGroups: async () => [], getGroup: async () => null, deleteGroup: async () => {} };
const stubActionDeps: any = {
  stores: { atomic: null, blob: null, query: null, metrics: null },
  providers: { container: {}, dns: {}, resolveContainer: async () => ({}) },
  audit: { write: async () => {} },
  eventBus: { on: () => {}, dispatch: async () => {} },
  eventLoop: { enqueuePriority: () => {} },
  queueProducer: { send: async () => false, sendSandboxGc: async () => false, sendImagePull: async () => false, sendSandboxProvision: async () => false, sendBatch: async () => 0 },
};

// ─── Build spec ───

const app = new OpenAPIHono();

// Register all OpenAPIHono routers
app.route('/', createInfoHandler(stubStores as any));
app.route('/api/users', createUserRouter(stubUserService as any));
app.route('/api/permissions', createPermissionRouter(stubPermService as any));
app.route('/api/system-groups', createSysGroupRouter(stubSysGroupService as any));
app.route('/api/templates', createTemplateRouter(stubAtomic as any, stubPodSvc));
app.route('/api/pods', createPodRouter(undefined, stubPodSvc));
app.route('/api/platforms', createPlatformsRouter(stubRegistry as any));
app.route('/api/volumes', createVolumeRouter(stubVolumeSvc));
app.route('/api/networks', createSecurityGroupRouter(stubNetworkSvc));
app.route('/api/subnets', createSubnetRouter(stubSubnetSvc));
app.route('/api/topology', createTopologyRouter(stubClusterSvc, stubBucketSvc, stubImageSvc, undefined, stubPolicyMgr));
app.route('/api/images', createImagesRouter(stubProvidersRegistry as any));
app.route('/api/container-secrets', createContainerSecretRouter(stubContainerSecretSvc));
app.route('/api/instances', createInstancesRouter(stubInstancesSvc));
app.route('/api/security', createSecurityRouter({ securityService: stubSecuritySvc, s3ProviderResolver: stubS3Resolver }));
app.route('/api/storage', createStorageRouter({ s3ProviderResolver: stubS3Resolver }));
app.route('/api/actions', createActionsRouter(stubActionDeps));
// Audit router uses plain Hono (not OpenAPIHono) — routes added manually below
const auditRouter = createAuditRouter(new WorkersAuditLogger());
const auditRoutes: { method: string; path: string }[] = [];
for (const r of auditRouter.routes) {
  auditRoutes.push({ method: r.method.toUpperCase(), path: '/api/audit' + r.path });
}

// Generate spec from OpenAPIHono registry
const spec: OpenAPIObject = app.getOpenAPIDocument({
  openapi: '3.0.3',
  info: {
    title: 'HBI-AAD API',
    version: '4.0.0',
    description:
      'Hermetic Backend Instance Assembly Audit Dispatcher — Cloudflare Workers based pod orchestration API.\n\n'
      + 'Authentication: Bearer token obtained via `POST /api/users/register` or `POST /api/users/login`.\n\n'
      + 'All API endpoints are prefixed with `/api/` except the info endpoint.',
  },
  servers: [
    { url: 'http://localhost:3000', description: 'Local development' },
    { url: 'https://hbi-aad.example.com', description: 'Production' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'UUID',
        description: 'Session token from POST /api/users/register or /api/users/login',
      },
    },
  },
  // ponytail: tags are auto-generated by getOpenAPIDocument from route metadata
});

// ─── Fix paths: getOpenAPIDocument outputs :param but OpenAPI needs {param} ───

const paramRe = /:(\w+)/g;
for (const [oldPath, methods] of Object.entries(spec.paths)) {
  const newPath = oldPath.replace(paramRe, '{$1}');
  if (newPath !== oldPath) {
    spec.paths[newPath] = methods;
    delete spec.paths[oldPath];
  }
}

// ─── Post-process: extract inline schemas into components.schemas with $ref ───
// OkResponse(schema) wraps schema in { success: true, data: ... }, which prevents
// zod-to-openapi from generating $ref. We scan all paths for OkResponse-shaped
// schemas, extract unique data schemas into components, and replace with $ref.

const dataSchemaMap = new Map<string, { schema: any; count: number; name?: string }>();
for (const [, methods] of Object.entries(spec.paths)) {
  for (const [, op] of Object.entries(methods as object)) {
    const resp = (op as any).responses;
    if (!resp) continue;
    for (const [, content] of Object.entries(resp)) {
      const jsonSchema = (content as any)?.content?.['application/json']?.schema;
      if (!jsonSchema || jsonSchema.$ref) continue;
      const props = jsonSchema.properties;
      if (jsonSchema.type !== 'object' || !props?.success || !props?.data) continue;
      const key = JSON.stringify(props.data);
      const entry = dataSchemaMap.get(key) ?? { schema: props.data, count: 0 };
      entry.count++;
      dataSchemaMap.set(key, entry);
    }
  }
}
// Assign names: simple numeric naming for shared schemas
let schemaIndex = 0;
if (!spec.components) spec.components = {};
if (!spec.components.schemas) spec.components.schemas = {};
for (const [key, entry] of dataSchemaMap) {
  if (entry.count < 2) continue;
  const parsed = JSON.parse(key);
  const name = `Shared${++schemaIndex}`;
  spec.components.schemas[name] = parsed;
  entry.name = name;
}
// Second pass: replace data schemas with $ref where components were created
for (const [, methods] of Object.entries(spec.paths)) {
  for (const [, op] of Object.entries(methods as object)) {
    const resp = (op as any).responses;
    if (!resp) continue;
    for (const [, content] of Object.entries(resp)) {
      const jsonSchema = (content as any)?.content?.['application/json']?.schema;
      if (!jsonSchema || jsonSchema.$ref) continue;
      const props = jsonSchema.properties;
      if (jsonSchema.type !== 'object' || !props?.success || !props?.data) continue;
      const key = JSON.stringify(props.data);
      const match = [...dataSchemaMap.values()].find(e => e.name && JSON.stringify(e.schema) === key);
      if (match?.name) {
        props.data = { $ref: `#/components/schemas/${match.name}` };
      }
    }
  }
}

// ─── Manually add routes not in OpenAPIRegistry ───

const manualRoutes: { method: string; path: string; tag: string; description: string }[] = [
  // Audit (plain Hono router, no schema metadata)
  ...auditRoutes.map(r => ({ ...r, tag: 'Audit', description: '' })),
  // Dev
  { method: 'POST', path: '/__tick', tag: 'Dev', description: 'Tick the event loop' },
  { method: 'POST', path: '/__admin/migrate-user-index', tag: 'Dev', description: 'Migrate user index' },
  { method: 'POST', path: '/api/sudo', tag: 'Dev', description: 'Sudo action' },
  // Public
  { method: 'GET', path: '/api/openapi.json', tag: 'Public', description: 'OpenAPI specification' },
  // Notifications
  { method: 'GET', path: '/api/ws/notifications', tag: 'Notifications', description: 'WebSocket notifications' },
  // Events sub-router
  { method: 'POST', path: '/api/events', tag: 'Events', description: 'Publish event' },
  { method: 'GET', path: '/api/events/loop/status', tag: 'Events', description: 'Event loop status' },
  { method: 'POST', path: '/api/events/loop/start', tag: 'Events', description: 'Start event loop' },
  { method: 'POST', path: '/api/events/loop/stop', tag: 'Events', description: 'Stop event loop' },
  { method: 'POST', path: '/api/events/loop/pause', tag: 'Events', description: 'Pause event loop' },
  { method: 'POST', path: '/api/events/loop/resume', tag: 'Events', description: 'Resume event loop' },
  { method: 'POST', path: '/api/events/loop/configure', tag: 'Events', description: 'Configure event loop' },
];

for (const mr of manualRoutes) {
  const p = toOpenApiPath(mr.path);
  if (!spec.paths[p]) spec.paths[p] = {};
  if (!(spec.paths[p] as Record<string, unknown>)[mr.method.toLowerCase()]) {
    const parameters: Record<string, unknown>[] = [];
    for (const pp of mr.path.matchAll(/:(\w+)/g)) {
      parameters.push({ name: pp[1]!, in: 'path', required: true, schema: { type: 'string' }, description: pp[1] });
    }
    (spec.paths[p] as Record<string, unknown>)[mr.method.toLowerCase()] = {
      tags: [mr.tag],
      summary: `${mr.method} ${mr.path}`,
      description: mr.description,
      parameters,
      responses: { '200': { description: 'Success', content: { 'application/json': { schema: { type: 'object' } } } } },
    };
  }
}

// Add security scheme to all /api/ endpoints
for (const [path, methods] of Object.entries(spec.paths)) {
  if (!path.startsWith('/api/')) continue;
  if (path === '/api/users/register' || path === '/api/users/login') continue;
  for (const method of Object.keys(methods as Record<string, unknown>)) {
    const op = (methods as Record<string, unknown>)[method] as Record<string, unknown>;
    if (!op.security) op.security = [{ bearerAuth: [] }];
  }
}

// ─── Auto-fill missing path parameters ───
for (const [path, methods] of Object.entries(spec.paths)) {
  const expected = [...path.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
  if (expected.length === 0) continue;
  for (const [, op] of Object.entries(methods as object)) {
    const opObj = op as Record<string, unknown>;
    const existing = new Set(((opObj.parameters ?? []) as Array<Record<string, unknown>>)
      .filter(p => p.in === 'path').map(p => p.name));
    for (const pp of expected) {
      if (!existing.has(pp)) {
        if (!opObj.parameters) opObj.parameters = [];
        (opObj.parameters as Array<Record<string, unknown>>).push({
          name: pp, in: 'path', required: true, schema: { type: 'string' }, description: pp,
        });
      }
    }
  }
}

// ─── Write output ───

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(__dirname, '..', 'openapi.json');
writeFileSync(outputPath, JSON.stringify(spec, null, 2), 'utf-8');
const routeCount = Object.values(spec.paths).reduce((sum, m) => sum + Object.keys(m as object).length, 0);
console.log(`✓ Generated ${outputPath} (${routeCount} routes, ${Object.keys(spec.paths).length} paths)`);

// ─── Summary ───

const summary = {
  totalRoutes: routeCount,
  totalPaths: Object.keys(spec.paths).length,
  tags: spec.tags?.map((t: any) => t.name ?? t) ?? [],
  endpoints: Object.entries(spec.paths).flatMap(([p, methods]) =>
    Object.keys(methods as object).map(m => `${m.toUpperCase()} ${p}`),
  ),
};
const summaryPath = resolve(__dirname, '..', 'openapi-summary.json');
writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
console.log(`✓ Generated ${summaryPath}`);

// Exit cleanly — DagScheduler etc. may have background timers
process.exit(0);
