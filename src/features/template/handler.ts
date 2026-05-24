import { Hono } from 'hono';
import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { RouteMeta } from '../../core/http-docs/types.ts';
import { ok, fail } from '../../core/response.ts';
import type { AppContext } from '../../core/app.ts';
import type { ISandboxService } from '../sandbox/interfaces.ts';
import type { SandboxTemplate, CreateTemplateInput, UpdateTemplateInput, TemplateSpec, TemplateContainer } from './types.ts';
import { TemplateVisibility } from './types.ts';
import type { IProviderRegistry } from '../../core/provider/interfaces.ts';
import { applyTemplate } from './applicator.ts';
import { SandboxService } from '../sandbox/sandbox.service.ts';
import { ConsoleLogger } from '../../core/logger/console-logger.ts';

type PermissionCheckFn = { check(params: { userId: string; action: string; resource: string; ip?: string }): Promise<{ allowed: boolean; reason: string }> };

async function requirePerm(c: any, checker: PermissionCheckFn | undefined, action: string, resource: string): Promise<Response | null> {
  if (!checker) return null;
  const user = (c as any).var?.currentUser;
  if (!user) return null;
  const result = await checker.check({ userId: user.id, action, resource });
  if (!result.allowed) return c.json(fail('FORBIDDEN', result.reason), 403);
  return null;
}

const PREFIX = 'sandbox-tpl:';
const INDEX_KEY = 'sandbox-tpl:ids';

function genId(): string { return `tpl_${crypto.randomUUID()}`; }

/** Check if the current user has root-level privileges. */
function isUserRoot(user: { role?: string } | undefined): boolean {
  return user?.role === 'root' || user?.role === 'Operator' || user?.role === 'wheel';
}

/**
 * For non-root users: replace all liveness probes with a safe TCP probe.
 */
function enforceSafeProbes(containers: readonly TemplateContainer[] | undefined): readonly TemplateContainer[] | undefined {
  if (!containers) return undefined;
  return containers.map((c: any) => ({
    ...c,
    livenessProbe: { tcpSocket: { port: c.ports?.[0]?.containerPort ?? 80 }, periodSeconds: 30, failureThreshold: 3 },
  }));
}

// ─── DAG resolver ───

function resolveDag(tpls: SandboxTemplate[], seedIds: string[]): SandboxTemplate[] {
  const visited = new Set<string>();
  const result: SandboxTemplate[] = [];
  const stack = [...seedIds];
  while (stack.length) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const tpl = tpls.find(t => t.id === id);
    if (tpl) {
      result.push(tpl);
      if (tpl.dependsOn) stack.push(...tpl.dependsOn);
    }
  }
  return result;
}

/** Deep-merge two plain objects — child values override parents. */
function deepMerge(parent: any, child: any): any {
  if (!parent) return child ?? {};
  if (!child) return parent;
  const out = { ...parent };
  for (const k of Object.keys(child)) {
    if (k === 'containers' || k === 'initContainers' || k === 'storage') {
      out[k] = mergeByName(out[k], child[k]);
    } else if (typeof child[k] === 'object' && child[k] !== null && !Array.isArray(child[k]) && typeof parent[k] === 'object' && parent[k] !== null) {
      out[k] = deepMerge(parent[k], child[k]);
    } else {
      out[k] = child[k];
    }
  }
  return out;
}

function mergeByName(parent: any[] | undefined, child: any[] | undefined): any[] {
  if (!child) return parent ?? [];
  if (!parent) return child;
  const map = new Map<string, any>();
  for (const item of parent) map.set(item.name, item);
  for (const item of child) {
    const existing = map.get(item.name);
    if (existing) map.set(item.name, deepMerge(existing, item));
    else map.set(item.name, item);
  }
  return [...map.values()];
}

async function resolveTemplate(atomic: IAtomicStore, id: string): Promise<SandboxTemplate> {
  const all = await listAll(atomic);
  const tpl = all.find(t => t.id === id);
  if (!tpl) throw Object.assign(new Error('Template not found'), { status: 404 });

  const chain = resolveDag(all, [id]).reverse();
  let mergedSpec: TemplateSpec = {} as TemplateSpec;
  for (const t of chain) {
    mergedSpec = deepMerge(mergedSpec, t.spec) as TemplateSpec;
  }
  return { ...tpl, spec: mergedSpec };
}

async function listAll(atomic: IAtomicStore): Promise<SandboxTemplate[]> {
  const idx = await atomic.get<string[]>(INDEX_KEY);
  if (!idx) return [];
  const entries = await Promise.all(idx.value.map(id => atomic.get<SandboxTemplate>(PREFIX + id)));
  return entries.filter(e => e).map(e => e!.value);
}

// ─── Instance limit enforcement ───

/** Counter key for total instances of a template. */
function countKey(tplId: string): string { return `tpl:cnt:${tplId}`; }
/** Counter key for per-user instances of a template. */
function userCountKey(tplId: string, userId: string): string { return `tpl:cnt:${tplId}:${userId}`; }
/** Binding key for domain+port claim. */
function bindingKey(domain: string, port: number): string { return `tpl:bind:${domain}:${port}`; }

/**
 * Check and claim an instance slot for a template.
 * Throws an HTTP-like error (with `status` property) if the limit is exceeded.
 * On success, increments the relevant counters.
 */
async function claimInstanceSlot(
  atomic: IAtomicStore,
  tpl: SandboxTemplate,
  userId: string,
): Promise<void> {
  const limit = tpl.spec.instanceLimit;
  if (!limit) return; // no limit = always allowed

  const { type, max } = limit;

  if (type === 'fixed') {
    // Fixed: only one instance ever. Check the binary marker.
    const key = countKey(tpl.id);
    const entry = await atomic.get<number>(key);
    if (entry && entry.value >= max) {
      const err: any = new Error(`Template "${tpl.name}" is fixed to ${max} instance(s) — already used`);
      err.status = 429;
      throw err;
    }
    await atomic.set(key, (entry?.value ?? 0) + 1, entry?.version ?? null);
    return;
  }

  if (type === 'perSystem') {
    const key = countKey(tpl.id);
    const entry = await atomic.get<number>(key);
    if (entry && entry.value >= max) {
      const err: any = new Error(`Template "${tpl.name}" system limit of ${max} reached`);
      err.status = 429;
      throw err;
    }
    await atomic.set(key, (entry?.value ?? 0) + 1, entry?.version ?? null);
    return;
  }

  if (type === 'perUser') {
    const key = userCountKey(tpl.id, userId);
    const entry = await atomic.get<number>(key);
    if (entry && entry.value >= max) {
      const err: any = new Error(`Template "${tpl.name}" per-user limit of ${max} reached`);
      err.status = 429;
      throw err;
    }
    await atomic.set(key, (entry?.value ?? 0) + 1, entry?.version ?? null);
    return;
  }
}

/**
 * Claim a resource binding (domain:port) — prevents two users from binding
 * the same domain+port.
 */
async function claimResourceBinding(
  atomic: IAtomicStore,
  tpl: SandboxTemplate,
): Promise<void> {
  const binding = tpl.spec.resourceBinding;
  if (!binding?.domain || !binding.port) return;

  const key = bindingKey(binding.domain, binding.port);
  const entry = await atomic.get<string>(key);
  if (entry) {
    const err: any = new Error(`Domain ${binding.domain}:${binding.port} is already bound to another instance`);
    err.status = 409;
    throw err;
  }
  await atomic.set(key, tpl.id, null);
}

// ─── Visibility check ───

/** Check if the current user can access (view/apply) a template. */
function canAccessTemplate(tpl: SandboxTemplate, user: { id: string; role?: string } | undefined): boolean {
  if (isUserRoot(user)) return true; // root can see everything
  if (!tpl.spec.visibility || tpl.spec.visibility === TemplateVisibility.PUBLIC) return true;
  if (tpl.spec.visibility === TemplateVisibility.PRIVATE) {
    return tpl.creatorId === user?.id;
  }
  return true;
}

// ─── Router ───

export function createTemplateRouter(atomic: IAtomicStore, sandboxService?: ISandboxService, providers?: IProviderRegistry, permissionChecker?: PermissionCheckFn): Hono<{ Variables: AppContext }> {
  const router = new Hono<{ Variables: AppContext }>();

  // POST / — create a template
  router.post('/', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'create', 'template'); if (r) return r; }
    const body = await c.req.json() as CreateTemplateInput;
    if (!body.name || !body.spec) return c.json(fail('VALIDATION_ERROR', 'name and spec required'), 400);

    const user = (c as any).var?.currentUser as { id: string; role?: string } | undefined;
    if (!isUserRoot(user) && body.spec.containers) {
      body.spec = { ...body.spec, containers: enforceSafeProbes(body.spec.containers) as any };
    }

    const now = Date.now();
    const tpl: SandboxTemplate = {
      id: genId(),
      name: body.name,
      description: body.description,
      spec: body.spec as TemplateSpec,
      dependsOn: body.dependsOn,
      creatorId: user?.id,
      createdAt: now,
      updatedAt: now,
    };
    await atomic.set(PREFIX + tpl.id, tpl, null);
    const idx = await atomic.get<string[]>(INDEX_KEY);
    await atomic.set(INDEX_KEY, [...(idx?.value ?? []), tpl.id], idx?.version ?? null);
    return c.json(ok(tpl), 201);
  });

  // GET / — list all templates (filtered by visibility)
  router.get('/', async (c) => {
    const user = (c as any).var?.currentUser as { id: string; role?: string } | undefined;
    const all = await listAll(atomic);
    const visible = user ? all.filter(t => canAccessTemplate(t, user)) : all;
    return c.json(ok(visible));
  });

  // GET /:id — get a template (raw, unresolved)
  router.get('/:id', async (c) => {
    const entry = await atomic.get<SandboxTemplate>(PREFIX + c.req.param('id'));
    if (!entry) return c.json(fail('TEMPLATE_NOT_FOUND', 'Template not found'), 404);
    const user = (c as any).var?.currentUser as { id: string; role?: string } | undefined;
    if (!canAccessTemplate(entry.value, user)) {
      return c.json(fail('TEMPLATE_NOT_FOUND', 'Template not found'), 404);
    }
    return c.json(ok(entry.value));
  });

  // GET /:id/resolved — get a template with DAG-inherited spec merged
  router.get('/:id/resolved', async (c) => {
    try {
      const resolved = await resolveTemplate(atomic, c.req.param('id'));
      const user = (c as any).var?.currentUser as { id: string; role?: string } | undefined;
      if (!canAccessTemplate(resolved, user)) {
        return c.json(fail('TEMPLATE_NOT_FOUND', 'Template not found'), 404);
      }
      return c.json(ok(resolved));
    } catch (e: any) {
      return c.json(fail(e.status === 404 ? 'TEMPLATE_NOT_FOUND' : 'RESOLVE_ERROR', e.message), e.status ?? 500);
    }
  });

  // POST /:id/apply — apply a template to create a sandbox
  router.post('/:id/apply', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'create', 'sandbox'); if (r) return r; }
    try {
      const resolved = await resolveTemplate(atomic, c.req.param('id'));
      const body: any = await c.req.json().catch(() => ({}));

      const user = (c as any).var?.currentUser as { id: string; role?: string } | undefined;

      // Visibility check
      if (!canAccessTemplate(resolved, user)) {
        return c.json(fail('TEMPLATE_NOT_FOUND', 'Template not found'), 404);
      }

      // Instance limit check
      await claimInstanceSlot(atomic, resolved, user?.id ?? 'anonymous');
      await claimResourceBinding(atomic, resolved);

      // Non-root users: force safe probes
      let spec = resolved.spec;
      if (!isUserRoot(user) && spec.containers) {
        spec = { ...spec, containers: enforceSafeProbes(spec.containers) as any };
      }

      const providerName = body.provider ?? spec.provider;
      let svc = sandboxService;
      if (providerName && providers) {
        const entry = providers.provider(providerName);
        if (!entry) return c.json(fail('PROVIDER_NOT_FOUND', `Provider "${providerName}" not available`), 400);
        svc = new SandboxService(atomic, new ConsoleLogger(), entry.container);
      }
      if (!svc) return c.json(fail('SERVICE_UNAVAILABLE', 'Sandbox service not available'), 503);

      const input = applyTemplate({ ...resolved, spec }, body.name, body.region);
      const sandbox = await svc.provision(
        user?.id ? { ...input, creatorId: user.id } : input,
      );
      return c.json(ok(sandbox), 201);
    } catch (e: any) {
      return c.json(fail(e.status === 404 ? 'TEMPLATE_NOT_FOUND' : 'APPLY_FAILED', e.message), e.status ?? 500);
    }
  });

  // PUT /:id — update a template
  router.put('/:id', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'update', 'template'); if (r) return r; }
    const entry = await atomic.get<SandboxTemplate>(PREFIX + c.req.param('id'));
    if (!entry) return c.json(fail('TEMPLATE_NOT_FOUND', 'Template not found'), 404);
    const body = await c.req.json() as UpdateTemplateInput;

    const user = (c as any).var?.currentUser as { id: string; role?: string } | undefined;
    if (!isUserRoot(user) && body.spec?.containers) {
      body.spec = { ...body.spec, containers: enforceSafeProbes(body.spec.containers) as any };
    }
    const updated: SandboxTemplate = {
      ...entry.value,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description ?? undefined } : {}),
      ...(body.spec !== undefined ? { spec: body.spec as TemplateSpec } : {}),
      ...(body.dependsOn !== undefined ? { dependsOn: body.dependsOn ?? [] } : {}),
      updatedAt: Date.now(),
    };
    await atomic.set(PREFIX + updated.id, updated, entry.version);
    return c.json(ok(updated));
  });

  // DELETE /:id — delete a template
  router.delete('/:id', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'delete', 'template'); if (r) return r; }
    const entry = await atomic.get<SandboxTemplate>(PREFIX + c.req.param('id'));
    if (!entry) return c.json(fail('TEMPLATE_NOT_FOUND', 'Template not found'), 404);
    await atomic.set(PREFIX + c.req.param('id'), null, entry.version);
    const idx = await atomic.get<string[]>(INDEX_KEY);
    if (idx) await atomic.set(INDEX_KEY, idx.value.filter((i: string) => i !== c.req.param('id')), idx.version);
    return c.json(ok(null));
  });

  return router;
}

export const templateRouteMeta: RouteMeta[] = [
  { method: 'POST', path: '/', description: '创建沙箱模板 — visibility 控制可见性，instanceLimit 控制实例上限', requestBody: { name: 'mc-server', spec: { region: 'cn-hangzhou', containers: [{ name: 'app', image: 'nginx' }], visibility: 'private', instanceLimit: { type: 'perUser', max: 3 } } }, responseDescription: 'SandboxTemplate' },
  { method: 'GET', path: '/', description: '列出所有模板（按 visibility 过滤 — private 模板仅创建者可见）', responseDescription: 'SandboxTemplate[]' },
  { method: 'GET', path: '/:id', description: '按 ID 获取模板', responseDescription: 'SandboxTemplate' },
  { method: 'GET', path: '/:id/resolved', description: '获取模板解析结果 — 合并 DAG 继承链后完整的 spec', responseDescription: 'SandboxTemplate' },
  { method: 'POST', path: '/:id/apply', description: '应用模板创建沙箱 — 检查 visibility、instanceLimit、resourceBinding（domain:port 排他）', requestBody: { name: 'my-sandbox' }, responseDescription: 'Sandbox' },
  { method: 'PUT', path: '/:id', description: '更新模板', requestBody: { name: 'updated-name' }, responseDescription: 'SandboxTemplate' },
  { method: 'DELETE', path: '/:id', description: '删除模板', responseDescription: '{ ok: true }' },
];

export { resolveTemplate };
