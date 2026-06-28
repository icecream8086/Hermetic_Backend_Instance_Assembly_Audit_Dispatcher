import { Hono } from 'hono';
import type { Context } from 'hono';
import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { RouteMeta } from '../../core/http-docs/types.ts';
import { ok, fail } from '../../core/response.ts';
import type { AppContext } from '../../core/deps.ts';
import type { ISandboxService } from '../sandbox/interfaces.ts';
import type { SandboxTemplate, CreateTemplateInput, UpdateTemplateInput, ContainerSpec, ContainerDef, HealthCheckDef, NetworkSpec, TemplateExtensions, TemplateInstanceLimit } from './types.ts';
import { KernLevel } from '../../core/audit/kern-level.ts';
import { TemplateVisibility } from './types.ts';
import type { IProviderRegistry } from '../../core/provider/interfaces.ts';
import { applyTemplate } from './applicator.ts';
import { SandboxService } from '../sandbox/sandbox.service.ts';
import { ConsoleLogger } from '../../core/audit/console-logger.ts';
import { SandboxStatus } from '../sandbox/types.ts';
import { podSpecToSandboxInput } from '../sandbox/sandbox.service.ts';
import type { PodSpec } from '../sandbox/assembly/types.ts';
import { UserRole } from '../users/types.ts';
import { createAtomicNetworkResolver } from '../../core/network/resolver.ts';
import { InstanceService } from '../../core/region/instance.ts';
import type { InstanceId } from '../../core/region/instance.ts';
import type { RegionId } from '../../core/region/types.ts';
import { INSTANCE_TEMPLATES, type InstanceTemplateDef } from './templates.generated.ts';
import type { CrudHandlerMap } from '../../core/crud/router.ts';
import { registerCrudRoutes } from '../../core/crud/router.ts';

type PermissionCheckFn = { check(params: { userId: string; action: string; resource: string; ip?: string }): Promise<{ allowed: boolean; reason: string }> };

type TemplateEnv = { Variables: AppContext };

async function requirePerm(c: Context<TemplateEnv>, checker: PermissionCheckFn | undefined, action: string, resource: string, resourceOwnerId?: string): Promise<Response | null> {
  if (!checker) return null;
  const user = c.var.currentUser;
  if (!user) return null;
  const result = await checker.check({ userId: user.id, action, resource, ...(resourceOwnerId ? { resourceOwnerId } : {}) });
  if (!result.allowed) return c.json(fail('FORBIDDEN', result.reason), 403);
  return null;
}

const PREFIX = 'sandbox-tpl:';
const INDEX_KEY = 'sandbox-tpl:ids';

function genId(): string { return `tpl_${crypto.randomUUID()}`; }

/** Convert a YAML-generated InstanceTemplateDef to SandboxTemplate shape. */
function fromGeneratedTemplate(def: InstanceTemplateDef, defaultInstanceId?: string): SandboxTemplate {
  const s = def.spec;
  const now = Date.now();
  const cid = defaultInstanceId;

  const hasContainer = s.containers || s.initContainers || s.region !== undefined
    || s.restartPolicy !== undefined || (cid && !s.instanceId);

  return {
    id: def.id,
    name: def.name,
    description: def.description,
    apiVersion: (s.apiVersion as string | undefined) ?? 'hbi-aad/v1',
    kind: ((s.kind as string | undefined) ?? 'Container') as SandboxTemplate['kind'],
    dependsOn: (s.dependsOn as string[] | undefined) ?? [],
    createdAt: now,
    updatedAt: now,
    ...(hasContainer ? {
      container: {
        ...(s.region !== undefined ? { region: s.region as RegionId } : {}),
        ...(cid && !s.instanceId ? { instanceId: cid as InstanceId } : {}),
        ...(s.restartPolicy !== undefined ? { restartPolicy: s.restartPolicy as ContainerSpec['restartPolicy'] } : {}),
        ...(s.containers ? { containers: s.containers as ContainerDef[] } : {}),
        ...(s.initContainers ? { initContainers: s.initContainers as ContainerDef[] } : {}),
      } as ContainerSpec,
    } : {}),
    ...(s.singleton !== undefined ? { singleton: s.singleton as boolean } : {}),
    ...(s.healthChecks ? { healthChecks: s.healthChecks as HealthCheckDef[] } : {}),
    ...(s.network ? { network: s.network as NetworkSpec } : {}),
    ...(s.extensions ? { extensions: s.extensions as TemplateExtensions } : {}),
    ...(s.podSpec ? { podSpec: s.podSpec as PodSpec } : {}),
    ...(s.instanceLimit ? { instanceLimit: s.instanceLimit as TemplateInstanceLimit } : {}),
  };
}

/** Generated templates (YAML source-of-truth) as SandboxTemplate shape. */
function listGenerated(): SandboxTemplate[] {
  return INSTANCE_TEMPLATES.map(d => fromGeneratedTemplate(d));
}

// ─── systemd-style layered template resolution ───

interface ResolvedTemplate {
  source: 'generated' | 'store';
  template: SandboxTemplate;
}

/** Resolve a template by ID using systemd-style layering. */
async function resolveTemplateSource(atomic: IAtomicStore, id: string): Promise<ResolvedTemplate | null> {
  const storeEntry = await atomic.get<Record<string, unknown>>(PREFIX + id);
  if (storeEntry) {
    if (storeEntry.value.__deleted === true) return null;
    return { source: 'store', template: storeEntry.value as unknown as SandboxTemplate };
  }
  const gen = INSTANCE_TEMPLATES.find(d => d.id === id);
  if (gen) return { source: 'generated', template: fromGeneratedTemplate(gen) };
  return null;
}

/** List all live templates: generated (non-tombstoned) + store overrides/store-only. */
async function listAllLive(atomic: IAtomicStore): Promise<SandboxTemplate[]> {
  const generated = listGenerated();
  const stored = await listStored(atomic);
  const map = new Map<string, SandboxTemplate>();
  for (const t of generated) map.set(t.id, t);
  for (const t of stored) map.set(t.id, t);
  const result: SandboxTemplate[] = [];
  for (const t of map.values()) {
    const entry = await atomic.get<any>(PREFIX + t.id);
    if (entry?.value?.__deleted === true) continue;
    result.push(t);
  }
  return result;
}

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
export function deepMerge(parent: any, child: any): any {
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
  const result = await resolveTemplateWithChain(atomic, id);
  return result.template;
}

async function resolveTemplateWithChain(atomic: IAtomicStore, id: string): Promise<{ template: SandboxTemplate; chain: readonly string[] }> {
  const allTemplates = await listAllLive(atomic);
  const tpl = allTemplates.find(t => t.id === id);
  if (!tpl) throw Object.assign(new Error('Template not found'), { status: 404 });

  const chain = resolveDag(allTemplates, [id]).reverse();
  const chainIds = chain.map(t => t.id);
  let mergedSpec: any = {};
  for (const t of chain) {
    mergedSpec = deepMerge(mergedSpec, {
      ...(t.container ? { container: t.container } : {}),
      ...(t.healthChecks ? { healthChecks: t.healthChecks } : {}),
      ...(t.network ? { network: t.network } : {}),
      ...(t.extensions ? { extensions: t.extensions } : {}),
      ...(t.podSpec ? { podSpec: t.podSpec } : {}),
    });
  }
  return { template: { ...tpl, ...mergedSpec } as SandboxTemplate, chain: chainIds };
}

async function listStored(atomic: IAtomicStore): Promise<SandboxTemplate[]> {
  const idx = await atomic.get<string[]>(INDEX_KEY);
  if (!idx) return [];
  const entries = await Promise.all(idx.value.map(id => atomic.get<SandboxTemplate>(PREFIX + id)));
  return entries.filter(e => e).map(e => e!.value);
}

// ─── Instance limit enforcement ───

function lockKey(tplId: string, suffix = ''): string {
  let h = 5381;
  for (let i = 0; i < tplId.length; i++) h = ((h << 5) + h) + tplId.charCodeAt(i);
  return `tpl:lock:${Math.abs(h).toString(36)}${suffix}`;
}

const SANDBOX_INDEX_KEY = 'sandbox:ids';
const SANDBOX_PREFIX = 'sandbox:';

const LIVE_STATUSES: string[] = [
  SandboxStatus.Pending,
  SandboxStatus.Scheduling,
  SandboxStatus.Running,
  SandboxStatus.Succeeded,
  SandboxStatus.Terminating,
  SandboxStatus.Restarting,
  SandboxStatus.Updating,
];

async function countRunningForTemplate(atomic: IAtomicStore, tplId: string): Promise<number> {
  const idx = await atomic.get<string[]>(SANDBOX_INDEX_KEY);
  if (!idx) return 0;
  let count = 0;
  for (const sid of idx.value) {
    const entry = await atomic.get<any>(SANDBOX_PREFIX + sid);
    if (entry?.value?.config?.templateRef === tplId && LIVE_STATUSES.includes(entry.value.status)) {
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
  if (tpl.singleton) {
    const runningCount = await countRunningForTemplate(atomic, tpl.id);
    if (runningCount >= 1) {
      const err: any = new Error(`Template "${tpl.name}" is singleton — only 1 instance allowed at a time (${runningCount} running)`);
      err.status = 429;
      throw err;
    }
    const key = lockKey(tpl.id);
    const entry = await atomic.get<number>(key);
    await atomic.set(key, (entry?.value ?? 0) + 1, entry?.version ?? null);
    return;
  }

  const limit = tpl.instanceLimit;
  if (!limit) return;

  const { type, max } = limit;
  const baseKey = lockKey(tpl.id);
  const userKey = lockKey(tpl.id, ':' + userId);

  const runningCount = await countRunningForTemplate(atomic, tpl.id);

  if (type === 'fixed' || type === 'perSystem') {
    if (runningCount >= max) {
      const err: any = new Error(`Template "${tpl.name}" has ${runningCount} running instance(s) — limit is ${max}`);
      err.status = 429;
      throw err;
    }
    const entry = await atomic.get<number>(baseKey);
    await atomic.set(baseKey, (entry?.value ?? 0) + 1, entry?.version ?? null);
    return;
  }

  if (type === 'perUser') {
    const idx = await atomic.get<string[]>(SANDBOX_INDEX_KEY);
    let userCount = 0;
    if (idx) {
      for (const sid of idx.value) {
        const entry = await atomic.get<any>(SANDBOX_PREFIX + sid);
        if (entry?.value?.config?.templateRef === tpl.id
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
  const baseKey = lockKey(tpl.id);
  const entry = await atomic.get<number>(baseKey);
  if (entry && entry.value > 0) {
    await atomic.set(baseKey, entry.value - 1, entry.version).catch(() => {});
  }
  if (tpl.instanceLimit?.type === 'perUser') {
    const userKey = lockKey(tpl.id, ':' + _userId);
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

  const crud: CrudHandlerMap = {
    create: (r) => r.post('/', async (c) => {
      { const rv = await requirePerm(c, permissionChecker, 'create', 'template'); if (rv) return rv; }
      const body: CreateTemplateInput = await c.req.json();
      if (!body.name) return c.json(fail('VALIDATION_ERROR', 'name is required'), 400);

      const user = c.var.currentUser;
      if (!isUserRoot(user) && body.healthChecks) {
        body.healthChecks = body.healthChecks.filter(h => h.type !== 'liveness');
      }

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
    }),

    list: (r) => r.get('/', async (c) => {
      const user = c.var.currentUser;
      const page = parseInt(c.req.query('page') ?? '') || 1;
      const limit = parseInt(c.req.query('limit') ?? '') || 50;
      const name = c.req.query('name');
      const kind = c.req.query('kind');

      let visible = await listAllLive(atomic);
      if (user) visible = visible.filter(t => canAccessTemplate(t, user));
      if (name) visible = visible.filter(t => t.name.toLowerCase().includes(name.toLowerCase()));
      if (kind) visible = visible.filter(t => t.kind === kind);

      const total = visible.length;
      const start = (page - 1) * limit;
      const items = visible.slice(start, start + limit);
      return c.json(ok({ items, total, page, limit }));
    }),

    get: (r) => r.get('/:id', async (c) => {
      const resolved = await resolveTemplateSource(atomic, c.req.param('id'));
      if (!resolved) return c.json(fail('TEMPLATE_NOT_FOUND', 'Template not found'), 404);
      const user = c.var.currentUser;
      if (!canAccessTemplate(resolved.template, user)) {
        return c.json(fail('TEMPLATE_NOT_FOUND', 'Template not found'), 404);
      }
      return c.json(ok(resolved.template));
    }),

    update: (r) => r.put('/:id', async (c) => {
      const id = c.req.param('id');
      const user = c.var.currentUser;
      const resolved = await resolveTemplateSource(atomic, id);
      if (!resolved) return c.json(fail('TEMPLATE_NOT_FOUND', 'Template not found'), 404);

      if (resolved.source === 'generated' && !isUserRoot(user)) {
        return c.json(fail('FORBIDDEN', 'Only root can modify built-in templates'), 403);
      }
      if (resolved.source === 'store' && !isUserRoot(user) && resolved.template.creatorId !== user?.id) {
        return c.json(fail('FORBIDDEN', 'Not your template'), 403);
      }

      const body: UpdateTemplateInput = await c.req.json();
      if (body.singleton && body.instanceLimit) {
        return c.json(fail('VALIDATION_ERROR', 'singleton and instanceLimit are mutually exclusive'), 400);
      }

      const base = resolved.template;
      const updated: SandboxTemplate = {
        ...base,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description ?? undefined } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
        ...(body.singleton !== undefined ? { singleton: body.singleton } : {}),
        ...(body.instanceLimit !== undefined ? { instanceLimit: body.instanceLimit ?? undefined } : {}),
        ...(body.resourceBinding !== undefined ? { resourceBinding: body.resourceBinding ?? undefined } : {}),
        ...(body.container !== undefined ? { container: deepMerge(base.container ?? {}, body.container) } : {}),
        ...(body.healthChecks !== undefined ? { healthChecks: body.healthChecks } : {}),
        ...(body.network !== undefined ? { network: deepMerge(base.network ?? {}, body.network) } : {}),
        ...(body.extensions !== undefined ? { extensions: deepMerge(base.extensions ?? {}, body.extensions) } : {}),
        ...(body.dependsOn !== undefined ? { dependsOn: body.dependsOn ?? [] } : {}),
        ...(body.podSpec !== undefined ? { podSpec: body.podSpec ?? undefined } : {}),
        updatedAt: Date.now(),
        ...(resolved.source === 'generated' ? { __originalGenerated: true } : {}),
      };

      const existingVersion = resolved.source === 'store'
        ? (await atomic.get<SandboxTemplate>(PREFIX + id))?.version
        : null;
      await atomic.set(PREFIX + id, updated, existingVersion ?? null);
      if (resolved.source === 'generated') {
        const idx = await atomic.get<string[]>(INDEX_KEY);
        if (!idx?.value?.includes(id)) {
          await atomic.set(INDEX_KEY, [...(idx?.value ?? []), id], idx?.version ?? null);
        }
      }
      c.var.audit?.write({
        level: KernLevel.INFO,
        facility: 'template',
        message: `Template ${resolved.source === 'generated' ? 'overridden' : 'updated'} — ${updated.name}`,
        metadata: { eventType: 'template.updated', templateId: id, source: resolved.source, actorId: user?.id },
      });
      return c.json(ok(updated));
    }),

    delete: (r) => r.delete('/:id', async (c) => {
      const id = c.req.param('id');
      const user = c.var.currentUser;
      const resolved = await resolveTemplateSource(atomic, id);
      if (!resolved) return c.json(fail('TEMPLATE_NOT_FOUND', 'Template not found'), 404);

      if (resolved.source === 'generated') {
        if (!isUserRoot(user)) {
          return c.json(fail('FORBIDDEN', 'Only root can delete built-in templates'), 403);
        }
        const now = Date.now();
        await atomic.set(PREFIX + id, {
          __deleted: true,
          deletedBy: user?.id,
          deletedAt: now,
          __originalId: id,
        }, null);
        c.var.audit?.write({
          level: KernLevel.WARNING,
          facility: 'template',
          message: `Template masked — ${resolved.template.name} (tombstone)`,
          metadata: { eventType: 'template.masked', templateId: id, actorId: user?.id },
        });
        return c.json(ok({ masked: true, id }));
      }

      const entry = await atomic.get<SandboxTemplate>(PREFIX + id);
      if (!entry) return c.json(fail('TEMPLATE_NOT_FOUND', 'Template not found'), 404);
      if (!entry.value.creatorId) {
        return c.json(fail('MAC_DENIED', `Cannot delete seed template "${entry.value.name}" — protected by system policy`), 403);
      }
      if (!isUserRoot(user) && entry.value.creatorId !== user?.id) {
        return c.json(fail('FORBIDDEN', 'Not your template'), 403);
      }
      await atomic.set(PREFIX + id, null, entry.version);
      const idx = await atomic.get<string[]>(INDEX_KEY);
      if (idx) await atomic.set(INDEX_KEY, idx.value.filter((i: string) => i !== id), idx.version);
      c.var.audit?.write({
        level: KernLevel.WARNING,
        facility: 'template',
        message: `Template deleted — ${entry.value.name}`,
        metadata: { eventType: 'template.deleted', templateId: id, actorId: user?.id },
      });
      return c.json(ok(null));
    }),
  };

  registerCrudRoutes(router, crud);

  // ─── Extra routes ───

  router.get('/:id/resolved', async (c) => {
    try {
      const { template: resolved, chain } = await resolveTemplateWithChain(atomic, c.req.param('id'));
      const user = c.var.currentUser;
      if (!canAccessTemplate(resolved, user)) {
        return c.json(fail('TEMPLATE_NOT_FOUND', 'Template not found'), 404);
      }
      return c.json(ok({ ...resolved, _chain: chain }));
    } catch (e: any) {
      return c.json(fail(e.status === 404 ? 'TEMPLATE_NOT_FOUND' : 'RESOLVE_ERROR', e.message), e.status ?? 500);
    }
  });

  router.post('/:id/apply', async (c) => {
    { const r = await requirePerm(c, permissionChecker, 'create', 'sandbox'); if (r) return r; }
    let resolved;
    try {
      resolved = await resolveTemplate(atomic, c.req.param('id'));
      const body: any = await c.req.json().catch(() => ({}));

      const user = c.var.currentUser;

      if (!canAccessTemplate(resolved, user)) {
        return c.json(fail('TEMPLATE_NOT_FOUND', 'Template not found'), 404);
      }

      await claimInstanceSlot(atomic, resolved, user?.id ?? 'anonymous');
      await claimResourceBinding(atomic, resolved);

      if (resolved.kind === 'ContainerGroup' && resolved.podSpec) {
        const baseInput = podSpecToSandboxInput(resolved.podSpec as PodSpec);
        const input = { ...baseInput, apiVersion: 'hbi-aad/v2', templateRef: resolved.id, ...(user?.id ? { creatorId: user.id } : {}) };

        const explicitInstanceId = body.instanceId ?? (resolved.podSpec as any).instanceId as (string | undefined);
        const targetRegion = (body.region ?? (resolved.podSpec as any).region ?? baseInput.region) as (string | undefined);
        let svc = sandboxService;
        let resolvedInstanceId: string | undefined;

        if (explicitInstanceId && providers?.resolveContainer) {
          const instProvider = await providers.resolveContainer(explicitInstanceId as any);
          svc = new SandboxService(atomic, new ConsoleLogger(), instProvider, providers, undefined, undefined, createAtomicNetworkResolver(atomic), new InstanceService(atomic));
          resolvedInstanceId = explicitInstanceId as string;
        } else if (providers && targetRegion) {
          const instSvc = new InstanceService(atomic);
          const allInst = await instSvc.resolveByCapability('container');
          const match = allInst.find(i => i.status === 'online' && i.region === targetRegion);
          if (match) {
            const instProvider = await providers.resolveContainer(match.id as any);
            svc = new SandboxService(atomic, new ConsoleLogger(), instProvider, providers, undefined, undefined, createAtomicNetworkResolver(atomic), instSvc);
            resolvedInstanceId = match.id as string;
          }
        }

        const finalInput = resolvedInstanceId
          ? { ...input, instanceId: resolvedInstanceId as any }
          : input;

        if (!svc) return c.json(fail('SERVICE_UNAVAILABLE', 'Sandbox service not available'), 503);
        const sandbox = await svc.provision(finalInput);
        c.var.audit?.write({
          level: KernLevel.NOTICE,
          facility: 'template',
          message: `Template applied (v2) — ${resolved.name} → sandbox ${sandbox.id}`,
          metadata: { eventType: 'template.applied.v2', templateId: resolved.id, sandboxId: sandbox.id, actorId: user?.id },
        });
        return c.json(ok(sandbox), 201);
      }

      const providerName = body.provider;
      const explicitInstanceId = body.instanceId ?? resolved.container?.instanceId as (string | undefined);
      const targetRegion = (body.region ?? resolved.container?.region) as (string | undefined);
      let svc = sandboxService;
      let resolvedInstanceId: string | undefined;

      if (explicitInstanceId && providers?.resolveContainer) {
        const instProvider = await providers.resolveContainer(explicitInstanceId as any);
        svc = new SandboxService(atomic, new ConsoleLogger(), instProvider, providers, undefined, undefined, createAtomicNetworkResolver(atomic), new InstanceService(atomic));
        resolvedInstanceId = explicitInstanceId as string;
      } else if (providers && targetRegion) {
        const instSvc = new InstanceService(atomic);
        const allInst = await instSvc.resolveByCapability('container');
        const match = allInst.find(i => i.status === 'online' && i.region === targetRegion);
        if (match) {
          const instProvider = await providers.resolveContainer(match.id as any);
          svc = new SandboxService(atomic, new ConsoleLogger(), instProvider, providers, undefined, undefined, createAtomicNetworkResolver(atomic), instSvc);
          resolvedInstanceId = match.id as string;
        }
      } else if (providerName && providers) {
        const entry = providers.provider(providerName);
        if (!entry) return c.json(fail('PROVIDER_NOT_FOUND', `Provider "${providerName}" not available`), 400);
        svc = new SandboxService(atomic, new ConsoleLogger(), entry.container, providers, undefined, undefined, createAtomicNetworkResolver(atomic), new InstanceService(atomic));
      }
      if (!svc) return c.json(fail('SERVICE_UNAVAILABLE', 'Sandbox service not available'), 503);

      const baseInput = await applyTemplate(resolved, body.name, body.region, async (volumeId) => {
        const volEntry = await atomic.get<Record<string, unknown>>('volume:' + volumeId);
        return volEntry?.value ?? null;
      });
      const input = resolvedInstanceId
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
      if (resolved) {
        await releaseInstanceSlot(atomic, resolved, c.var.currentUser?.id ?? 'anonymous').catch(() => {});
        await releaseResourceBinding(atomic, resolved).catch(() => {});
      }
      return c.json(fail(code, e.message), status);
    }
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
