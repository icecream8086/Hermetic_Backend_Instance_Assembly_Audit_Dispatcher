import { Hono } from 'hono';
import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { RouteMeta } from '../../core/http-docs/types.ts';
import { ok, fail } from '../../core/response.ts';
import type { AppContext } from '../../core/deps.ts';
import type { ISandboxService } from '../sandbox/interfaces.ts';
import type { SandboxTemplate, CreateTemplateInput, UpdateTemplateInput } from './types.ts';
import { KernLevel } from '../../core/audit/kern-level.ts';
import { TemplateVisibility } from './types.ts';
import type { IProviderRegistry } from '../../core/provider/interfaces.ts';
import { applyTemplate } from './applicator.ts';
import { SandboxService } from '../sandbox/sandbox.service.ts';
import { ConsoleLogger } from '../../core/logger/console-logger.ts';
import { SandboxStatus } from '../sandbox/types.ts';
import { PodResolver } from '../sandbox/assembly/pod-resolver.ts';
import type { PodSpec } from '../sandbox/assembly/types.ts';
import { UserRole } from '../users/types.ts';
import { createAtomicNetworkResolver } from '../../core/network/resolver.ts';
import { InstanceService } from '../../core/region/instance.ts';

type PermissionCheckFn = { check(params: { userId: string; action: string; resource: string; ip?: string }): Promise<{ allowed: boolean; reason: string }> };

async function requirePerm(c: any, checker: PermissionCheckFn | undefined, action: string, resource: string, resourceOwnerId?: string): Promise<Response | null> {
  if (!checker) return null;
  const user = (c as any).var?.currentUser;
  if (!user) return null;
  const result = await checker.check({ userId: user.id, action, resource, ...(resourceOwnerId ? { resourceOwnerId } : {}) });
  if (!result.allowed) return c.json(fail('FORBIDDEN', result.reason), 403);
  return null;
}

const PREFIX = 'sandbox-tpl:';
const INDEX_KEY = 'sandbox-tpl:ids';

function genId(): string { return `tpl_${crypto.randomUUID()}`; }

/** Check if the current user has root-level privileges. */
function isUserRoot(user: { role?: string } | undefined): boolean {
  return user?.role === UserRole.Root || user?.role === UserRole.Operator;
}

// ─── DAG resolver ───

function resolveDag(tpls: SandboxTemplate[], seedIds: string[]): SandboxTemplate[] {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const result: SandboxTemplate[] = [];
  const stack: Array<{ id: string; phase: 'enter' | 'exit' }> = seedIds.map(id => ({ id, phase: 'enter' as const }));

  while (stack.length) {
    const frame = stack.pop()!;
    if (frame.phase === 'exit') {
      visited.add(frame.id);
      inStack.delete(frame.id);
      continue;
    }
    if (inStack.has(frame.id)) {
      throw Object.assign(new Error(`Cycle detected: template "${frame.id}" depends on itself (directly or transitively)`), { status: 400 });
    }
    if (visited.has(frame.id)) continue;
    inStack.add(frame.id);
    const tpl = tpls.find(t => t.id === frame.id);
    if (tpl) {
      result.push(tpl);
      if (tpl.dependsOn) {
        stack.push({ id: frame.id, phase: 'exit' });
        for (const dep of tpl.dependsOn) {
          stack.push({ id: dep, phase: 'enter' });
        }
      }
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
    if (k === 'containers' || k === 'initContainers') {
      out[k] = mergeByName(out[k], child[k]);
    } else if (k === 'healthChecks') {
      out[k] = mergeHealthChecks(out[k], child[k]);
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

/** Merge health checks by target+name — same target+name = merge fields. */
function mergeHealthChecks(parent: any[] | undefined, child: any[] | undefined): any[] {
  if (!child) return parent ?? [];
  if (!parent) return child;
  const keyFn = (h: any) => `${h.target}:${h.name}`;
  const map = new Map<string, any>();
  for (const h of parent) map.set(keyFn(h), h);
  for (const h of child) {
    const k = keyFn(h);
    const existing = map.get(k);
    if (existing) map.set(k, deepMerge(existing, h));
    else map.set(k, h);
  }
  return [...map.values()];
}

async function resolveTemplate(atomic: IAtomicStore, id: string): Promise<SandboxTemplate> {
  const all = await listAll(atomic);
  const tpl = all.find(t => t.id === id);
  if (!tpl) throw Object.assign(new Error('Template not found'), { status: 404 });

  // chain = [parent, child, ...] (root first — child overrides parent)
  const chain = resolveDag(all, [id]).reverse();
  let merged: any = {};
  for (const t of chain) {
    merged = deepMerge(merged, {
      ...(t.container ? { container: t.container } : {}),
      ...(t.healthChecks ? { healthChecks: t.healthChecks } : {}),
      ...(t.network ? { network: t.network } : {}),
      ...(t.extensions ? { extensions: t.extensions } : {}),
      ...(t.podSpec ? { podSpec: t.podSpec } : {}),
    });
  }
  // Keep original metadata, merge runtime fields
  return { ...tpl, ...merged } as SandboxTemplate;
}

async function listAll(atomic: IAtomicStore): Promise<SandboxTemplate[]> {
  const idx = await atomic.get<string[]>(INDEX_KEY);
  if (!idx) return [];
  const entries = await Promise.all(idx.value.map(id => atomic.get<SandboxTemplate>(PREFIX + id)));
  return entries.filter(e => e).map(e => e!.value);
}

// ─── Instance limit enforcement ───
// Lock key uses template name (hash) — renaming the template = different lock.
// Inherited templates must redeclare their own instanceLimit (not merged by DAG).
// Counts actual Running sandboxes by scanning the sandbox index.

/** Lock key based on template name (hash for atomic store key safety). */
function lockKey(tplName: string, suffix = ''): string {
  let h = 5381;
  for (let i = 0; i < tplName.length; i++) h = ((h << 5) + h) + tplName.charCodeAt(i);
  return `tpl:lock:${Math.abs(h).toString(36)}${suffix}`;
}

const SANDBOX_INDEX_KEY = 'sandbox:ids';
const SANDBOX_PREFIX = 'sandbox:';

/** Sandbox statuses that are considered "live" — count against the limit. */
const LIVE_STATUSES: string[] = [
  SandboxStatus.Pending,
  SandboxStatus.Scheduling,
  SandboxStatus.Running,
  SandboxStatus.Stopped,       // Stopped can be restarted
  SandboxStatus.Terminated,    // Terminated still has provider resources
];

/** Count running sandboxes for a given template name. */
async function countRunningForTemplate(atomic: IAtomicStore, tplName: string): Promise<number> {
  const idx = await atomic.get<string[]>(SANDBOX_INDEX_KEY);
  if (!idx) return 0;
  let count = 0;
  for (const sid of idx.value) {
    const entry = await atomic.get<any>(SANDBOX_PREFIX + sid);
    if (entry?.value?.name === tplName && LIVE_STATUSES.includes(entry.value.status)) {
      count++;
    }
  }
  return count;
}

async function claimInstanceSlot(
  atomic: IAtomicStore,
  tpl: SandboxTemplate,
  userId: string,
): Promise<void> {
  // singleton mode → acts as instanceLimit { type: 'fixed', max: 1 }
  if (tpl.singleton) {
    const runningCount = await countRunningForTemplate(atomic, tpl.name);
    if (runningCount >= 1) {
      const err: any = new Error(`Template "${tpl.name}" is singleton — only 1 instance allowed at a time (${runningCount} running)`);
      err.status = 429;
      throw err;
    }
    const key = lockKey(tpl.name);
    const entry = await atomic.get<number>(key);
    await atomic.set(key, (entry?.value ?? 0) + 1, entry?.version ?? null);
    return;
  }

  const limit = tpl.instanceLimit;
  if (!limit) return;

  const { type, max } = limit;
  const baseKey = lockKey(tpl.name);
  const userKey = lockKey(tpl.name, ':' + userId);

  // Check actual running count first (always run to ensure consistency)
  const runningCount = await countRunningForTemplate(atomic, tpl.name);

  if (type === 'fixed' || type === 'perSystem') {
    if (runningCount >= max) {
      const err: any = new Error(`Template "${tpl.name}" has ${runningCount} running instance(s) — limit is ${max}`);
      err.status = 429;
      throw err;
    }
    // Atomic counter for OCC across concurrent requests
    const entry = await atomic.get<number>(baseKey);
    await atomic.set(baseKey, (entry?.value ?? 0) + 1, entry?.version ?? null);
    return;
  }

  if (type === 'perUser') {
    // Count only this user's running sandboxes for this template
    const idx = await atomic.get<string[]>(SANDBOX_INDEX_KEY);
    let userCount = 0;
    if (idx) {
      for (const sid of idx.value) {
        const entry = await atomic.get<any>(SANDBOX_PREFIX + sid);
        if (entry?.value?.name === tpl.name
            && LIVE_STATUSES.includes(entry.value.status)
            && entry.value.config?.creatorId === userId) {
          userCount++;
        }
      }
    }
    if (userCount >= max) {
      const err: any = new Error(`Template "${tpl.name}" per-user limit of ${max} reached (${userCount} running)`);
      err.status = 429;
      throw err;
    }
    // Atomic counter for OCC
    const entry = await atomic.get<number>(userKey);
    await atomic.set(userKey, (entry?.value ?? 0) + 1, entry?.version ?? null);
    return;
  }
}

function bindingKey(domain: string, port: number): string { return `tpl:bind:${domain}:${port}`; }

async function claimResourceBinding(
  atomic: IAtomicStore,
  tpl: SandboxTemplate,
): Promise<void> {
  const binding = tpl.resourceBinding;
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

async function releaseResourceBinding(atomic: IAtomicStore, tpl: SandboxTemplate): Promise<void> {
  const binding = tpl.resourceBinding;
  if (!binding?.domain || !binding.port) return;
  const key = bindingKey(binding.domain, binding.port);
  const entry = await atomic.get<string>(key);
  if (entry) await atomic.set(key, null, entry.version).catch(() => {});
}

async function releaseInstanceSlot(atomic: IAtomicStore, tpl: SandboxTemplate, _userId: string): Promise<void> {
  if (!tpl.singleton && !tpl.instanceLimit) return;
  const baseKey = lockKey(tpl.name);
  const entry = await atomic.get<number>(baseKey);
  if (entry && entry.value > 0) {
    await atomic.set(baseKey, entry.value - 1, entry.version).catch(() => {});
  }
  // Also release per-user counter if applicable
  if (tpl.instanceLimit?.type === 'perUser') {
    const userKey = lockKey(tpl.name, ':' + _userId);
    const uEntry = await atomic.get<number>(userKey);
    if (uEntry && uEntry.value > 0) {
      await atomic.set(userKey, uEntry.value - 1, uEntry.version).catch(() => {});
    }
  }
}

function canAccessTemplate(tpl: SandboxTemplate, user: { id: string; role?: string } | undefined): boolean {
  if (isUserRoot(user)) return true;
  if (!tpl.visibility || tpl.visibility === TemplateVisibility.PUBLIC) return true;
  if (tpl.visibility === TemplateVisibility.PRIVATE) {
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
    const body: CreateTemplateInput = await c.req.json();
    if (!body.name) return c.json(fail('VALIDATION_ERROR', 'name is required'), 400);

    const user = (c as any).var?.currentUser as { id: string; role?: string } | undefined;
    if (!isUserRoot(user) && body.healthChecks) {
      // Non-root users cannot set liveness checks — force safe defaults
      body.healthChecks = body.healthChecks.filter(h => h.type !== 'liveness');
    }

    // Mutex: singleton and instanceLimit cannot both be set
    if (body.singleton && body.instanceLimit) {
      return c.json(fail('VALIDATION_ERROR', 'singleton and instanceLimit are mutually exclusive'), 400);
    }

    const now = Date.now();
    const tpl: SandboxTemplate = {
      id: genId(),
      name: body.name,
      description: body.description,
      apiVersion: body.apiVersion ?? 'hbi-aad/v1',
      kind: body.kind ?? 'Container',
      metadata: body.metadata,
      dependsOn: body.dependsOn,
      creatorId: user?.id,
      createdAt: now,
      updatedAt: now,
      visibility: undefined,
      singleton: body.singleton,
      instanceLimit: body.instanceLimit,
      resourceBinding: body.resourceBinding,
      container: body.container,
      healthChecks: body.healthChecks,
      network: body.network,
      extensions: body.extensions,
      podSpec: body.podSpec,
    };
    await atomic.set(PREFIX + tpl.id, tpl, null);
    const idx = await atomic.get<string[]>(INDEX_KEY);
    await atomic.set(INDEX_KEY, [...(idx?.value ?? []), tpl.id], idx?.version ?? null);
    c.var.audit?.write({
      level: KernLevel.NOTICE,
      facility: 'template',
      message: `Template created — ${tpl.name}`,
      metadata: { eventType: 'template.created', templateId: tpl.id, actorId: user?.id },
    });
    return c.json(ok(tpl), 201);
  });

  // GET / — list all templates (paginated, filtered by visibility + query)
  router.get('/', async (c) => {
    const user = (c as any).var?.currentUser as { id: string; role?: string } | undefined;
    const page = parseInt(c.req.query('page') ?? '') || 1;
    const limit = parseInt(c.req.query('limit') ?? '') || 50;
    const name = c.req.query('name');
    const idx = await atomic.get<string[]>(INDEX_KEY);
    const allIds = idx?.value ?? [];

    const entries = await Promise.all(allIds.map(id => atomic.get<SandboxTemplate>(PREFIX + id)));
    let visible = entries.filter(e => e).map(e => e!.value);
    if (user) visible = visible.filter(t => canAccessTemplate(t, user));
    if (name) visible = visible.filter(t => t.name.toLowerCase().includes(name.toLowerCase()));

    const total = visible.length;
    const start = (page - 1) * limit;
    const items = visible.slice(start, start + limit);
    return c.json(ok({ items, total, page, limit }));
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
    let resolved;  // hoisted for catch-block release
    try {
      resolved = await resolveTemplate(atomic, c.req.param('id'));
      const body: any = await c.req.json().catch(() => ({}));

      const user = (c as any).var?.currentUser as { id: string; role?: string } | undefined;

      if (!canAccessTemplate(resolved, user)) {
        return c.json(fail('TEMPLATE_NOT_FOUND', 'Template not found'), 404);
      }

      await claimInstanceSlot(atomic, resolved, user?.id ?? 'anonymous');
      await claimResourceBinding(atomic, resolved);

      // v2: ContainerGroup → PodResolver
      if (resolved.kind === 'ContainerGroup' && resolved.podSpec) {
        const groupProvider = providers?.groupContainer;
        if (!groupProvider) return c.json(fail('NOT_CONFIGURED', 'Container group provider not available'), 501);
        const resolver = new PodResolver(groupProvider);
        const result = await resolver.apply(resolved.podSpec as PodSpec);
        c.var.audit?.write({
          level: KernLevel.NOTICE,
          facility: 'template',
          message: `Template applied (v2 pod) — ${resolved.name}`,
          metadata: { eventType: 'template.applied.v2', templateId: resolved.id, actorId: user?.id },
        });
        return c.json(ok(result), 201);
      }

      // v1: single-container path — resolve instance dynamically
      const providerName = body.provider;
      const explicitInstanceId = body.instanceId ?? resolved.container?.instanceId as (string | undefined);
      const targetRegion = (body.region ?? resolved.container?.region) as (string | undefined);
      let svc = sandboxService;
      let resolvedInstanceId: string | undefined;

      if (explicitInstanceId && providers?.resolveContainer) {
        // 1. User or template explicitly picked an instance
        const instProvider = await providers.resolveContainer(explicitInstanceId as any);
        svc = new SandboxService(atomic, new ConsoleLogger(), instProvider, undefined, undefined, undefined, createAtomicNetworkResolver(atomic), new InstanceService(atomic));
        resolvedInstanceId = explicitInstanceId as string;
      } else if (providers && targetRegion) {
        // 2. Auto-resolve: pick first online instance in the requested region with container capability
        const instSvc = new InstanceService(atomic);
        const allInst = await instSvc.resolveByCapability('container');
        const match = allInst.find(i => i.status === 'online' && i.region === targetRegion);
        if (match) {
          const instProvider = await providers.resolveContainer(match.id as any);
          svc = new SandboxService(atomic, new ConsoleLogger(), instProvider, undefined, undefined, undefined, createAtomicNetworkResolver(atomic), instSvc);
          resolvedInstanceId = match.id as string;
        }
      } else if (providerName && providers) {
        // 3. Legacy: named provider from request body
        const entry = providers.provider(providerName);
        if (!entry) return c.json(fail('PROVIDER_NOT_FOUND', `Provider "${providerName}" not available`), 400);
        svc = new SandboxService(atomic, new ConsoleLogger(), entry.container, undefined, undefined, undefined, createAtomicNetworkResolver(atomic), new InstanceService(atomic));
      }
      if (!svc) return c.json(fail('SERVICE_UNAVAILABLE', 'Sandbox service not available'), 503);

      // Inject resolved instanceId into input if auto-resolved
      const baseInput = await applyTemplate(resolved, body.name, body.region, async (volumeId) => {
        const volEntry = await atomic.get<Record<string, unknown>>('volume:' + volumeId);
        return volEntry?.value ?? null;
      });
      const input = resolvedInstanceId && !explicitInstanceId
        ? { ...baseInput, instanceId: resolvedInstanceId as any }
        : baseInput;

      const sandbox = await svc.provision(
        user?.id ? { ...input, creatorId: user.id } : input,
      );
      c.var.audit?.write({
        level: KernLevel.NOTICE,
        facility: 'template',
        message: `Template applied — ${resolved.name} → sandbox ${sandbox.id}`,
        metadata: { eventType: 'template.applied', templateId: resolved.id, sandboxId: sandbox.id, actorId: user?.id },
      });
      return c.json(ok(sandbox), 201);
    } catch (e: any) {
      const status = typeof e.status === 'number' ? e.status : (typeof e.statusCode === 'number' ? e.statusCode : 500);
      const code = e.code && typeof e.code === 'string' ? e.code : (status === 404 ? 'TEMPLATE_NOT_FOUND' : 'APPLY_FAILED');
      console.error(`[template] apply failed for ${c.req.param('id')}:`, { code, status, message: e.message });
      // Release claimed resources if template resolution succeeded before the failure
      if (resolved) {
        await releaseInstanceSlot(atomic, resolved, (c as any).var?.currentUser?.id ?? 'anonymous').catch(() => {});
        await releaseResourceBinding(atomic, resolved).catch(() => {});
      }
      return c.json(fail(code, e.message), status);
    }
  });

  // PUT /:id — update a template
  router.put('/:id', async (c) => {
    const entry = await atomic.get<SandboxTemplate>(PREFIX + c.req.param('id'));
    if (!entry) return c.json(fail('TEMPLATE_NOT_FOUND', 'Template not found'), 404);
    { const r = await requirePerm(c, permissionChecker, 'update', 'template', entry.value.creatorId); if (r) return r; }
    const body: UpdateTemplateInput = await c.req.json();

    // Mutex: singleton and instanceLimit cannot both be set
    if (body.singleton && body.instanceLimit) {
      return c.json(fail('VALIDATION_ERROR', 'singleton and instanceLimit are mutually exclusive'), 400);
    }

    const updated: SandboxTemplate = {
      ...entry.value,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description ?? undefined } : {}),
      ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      ...(body.singleton !== undefined ? { singleton: body.singleton } : {}),
      ...(body.instanceLimit !== undefined ? { instanceLimit: body.instanceLimit ?? undefined } : {}),
      ...(body.resourceBinding !== undefined ? { resourceBinding: body.resourceBinding ?? undefined } : {}),
      ...(body.container !== undefined ? { container: body.container } : {}),
      ...(body.healthChecks !== undefined ? { healthChecks: body.healthChecks } : {}),
      ...(body.network !== undefined ? { network: body.network } : {}),
      ...(body.extensions !== undefined ? { extensions: body.extensions } : {}),
      ...(body.dependsOn !== undefined ? { dependsOn: body.dependsOn ?? [] } : {}),
      ...(body.podSpec !== undefined ? { podSpec: body.podSpec ?? undefined } : {}),
      updatedAt: Date.now(),
    };
    await atomic.set(PREFIX + updated.id, updated, entry.version);
    const user = (c as any).var?.currentUser as { id: string; role?: string } | undefined;
    c.var.audit?.write({
      level: KernLevel.INFO,
      facility: 'template',
      message: `Template updated — ${updated.name}`,
      metadata: { eventType: 'template.updated', templateId: updated.id, actorId: user?.id },
    });
    return c.json(ok(updated));
  });

  // DELETE /:id — delete a template
  router.delete('/:id', async (c) => {
    const entry = await atomic.get<SandboxTemplate>(PREFIX + c.req.param('id'));
    if (!entry) return c.json(fail('TEMPLATE_NOT_FOUND', 'Template not found'), 404);
    if (!entry.value.creatorId) {
      return c.json(fail('MAC_DENIED', `Cannot delete seed template "${entry.value.name}" — protected by system policy`), 403);
    }
    { const r = await requirePerm(c, permissionChecker, 'delete', 'template', entry.value.creatorId); if (r) return r; }
    const user = (c as any).var?.currentUser as { id: string; role?: string } | undefined;
    await atomic.set(PREFIX + c.req.param('id'), null, entry.version);
    const idx = await atomic.get<string[]>(INDEX_KEY);
    if (idx) await atomic.set(INDEX_KEY, idx.value.filter((i: string) => i !== c.req.param('id')), idx.version);
    c.var.audit?.write({
      level: KernLevel.WARNING,
      facility: 'template',
      message: `Template deleted — ${entry.value.name}`,
      metadata: { eventType: 'template.deleted', templateId: c.req.param('id'), actorId: user?.id },
    });
    return c.json(ok(null));
  });

  return router;
}

export const templateRouteMeta: RouteMeta[] = [
  { method: 'POST', path: '/', description: '创建模板 — v1 单容器 (kind=Container + container) / v2 容器组 (kind=ContainerGroup + podSpec, docker-compose 风格)', requestBody: { name: 'my-pod', apiVersion: 'hbi-aad/v2', kind: 'ContainerGroup', podSpec: { name: 'my-pod', region: 'local', services: { web: { image: 'nginx:latest' } } } }, responseDescription: 'SandboxTemplate' },
  { method: 'GET', path: '/', description: '列出所有模板（按 visibility 过滤 — private 模板仅创建者可见）', responseDescription: 'SandboxTemplate[]' },
  { method: 'GET', path: '/:id', description: '按 ID 获取模板', responseDescription: 'SandboxTemplate' },
  { method: 'GET', path: '/:id/resolved', description: '获取模板解析结果 — 合并 DAG 继承链后完整的 spec', responseDescription: 'SandboxTemplate' },
  { method: 'POST', path: '/:id/apply', description: '应用模板 — v1 创建沙箱 / v2 创建容器组 (PodResolver → IContainerGroupProvider)', requestBody: { name: 'my-sandbox' }, responseDescription: 'Sandbox | { providerId }' },
  { method: 'PUT', path: '/:id', description: '更新模板', requestBody: { name: 'updated-name' }, responseDescription: 'SandboxTemplate' },
  { method: 'DELETE', path: '/:id', description: '删除模板', responseDescription: '{ ok: true }' },
];

export { resolveTemplate };
