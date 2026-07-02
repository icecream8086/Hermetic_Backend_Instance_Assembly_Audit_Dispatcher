import { z } from 'zod';
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { IAtomicStore } from '../../core/store/interfaces.ts';
import { ok, fail } from '../../core/response.ts';
import { OkResponse, PaginatedResponse } from '../../core/http-docs/response-schema.ts';
import { SandboxTemplateSchema, ResolvedTemplateSchema, TemplateDeleteResponseSchema } from './response-schema.ts';
import { SandboxSchema } from '../sandbox/response-schema.ts';
import { AppError } from '../../core/types.ts';
import type { AppContext } from '../../core/deps.ts';
import type { ISandboxService } from '../sandbox/interfaces.ts';
import type { SandboxTemplate, CreateTemplateInput, UpdateTemplateInput, ContainerSpec, ContainerDef, HealthCheckDef, TemplateInstanceLimit } from './types.ts';
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

interface PermissionCheckFn { check(params: { userId: string; action: string; resource: string; ip?: string }): Promise<{ allowed: boolean; reason: string }> }

interface TemplateEnv { Variables: AppContext }

async function requirePerm(c: Context<TemplateEnv>, checker: PermissionCheckFn | undefined, action: string, resource: string, resourceOwnerId?: string): Promise<void> {
  if (!checker) return;
  const user = c.var.currentUser;
  if (!user) return;
  const result = await checker.check({ userId: user.id, action, resource, ...(resourceOwnerId ? { resourceOwnerId } : {}) });
  if (!result.allowed) throw new AppError(403, 'FORBIDDEN', result.reason);
}

const PREFIX = 'sandbox-tpl:';
const INDEX_KEY = 'sandbox-tpl:ids';

function genId(): string { return `tpl_${crypto.randomUUID()}`; }

/** Convert a YAML-generated InstanceTemplateDef to SandboxTemplate shape. */
function fromGeneratedTemplate(def: InstanceTemplateDef, defaultInstanceId?: string): SandboxTemplate {
  const s = def.spec;
  const now = Date.now();
  const cid = defaultInstanceId;

  // Extract typed spec fields (Record<string, unknown> → domain types)
  const apiVersion = z.string().optional().parse(s.apiVersion);
  const kind = z.custom<SandboxTemplate['kind']>().optional().parse(s.kind);
  const dependsOn = z.array(z.string()).optional().parse(s.dependsOn);
  const region = z.custom<RegionId>().optional().parse(s.region);
  const restartPolicy = z.string().optional().parse(s.restartPolicy);
  const containers = z.custom<ContainerDef[]>().optional().parse(s.containers);
  const initContainers = z.custom<ContainerDef[]>().optional().parse(s.initContainers);
  const singleton = z.boolean().optional().parse(s.singleton);
  const healthChecks = z.custom<HealthCheckDef[]>().optional().parse(s.healthChecks);
  const network = z.custom<Record<string, unknown>>().optional().parse(s.network);
  const extensions = z.custom<Record<string, unknown>>().optional().parse(s.extensions);
  const podSpec = z.custom<PodSpec>().optional().parse(s.podSpec);
  const instanceLimit = z.custom<TemplateInstanceLimit>().optional().parse(s.instanceLimit);

  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- boolean OR chain for feature detection, not default values
  const hasContainer = containers || initContainers || region !== undefined
    || restartPolicy !== undefined || (cid && !s.instanceId);

  const containerPart: { container: ContainerSpec } | Record<string, never> = hasContainer
    ? {
        container: {
          ...(region !== undefined ? { region } : {}),
          ...(cid && !s.instanceId ? { instanceId: cid } : {}),
          ...(restartPolicy !== undefined ? { restartPolicy } : {}),
          ...(containers !== undefined ? { containers } : {}),
          ...(initContainers !== undefined ? { initContainers } : {}),
        },
      }
    : {};

  return {
    id: def.id,
    name: def.name,
    description: def.description,
    apiVersion: apiVersion ?? 'hbi-aad/v1',
    kind: kind ?? 'Container',
    dependsOn: dependsOn ?? [],
    createdAt: now,
    updatedAt: now,
    ...containerPart,
    ...(singleton !== undefined ? { singleton } : {}),
    ...(healthChecks !== undefined ? { healthChecks } : {}),
    ...(network ? { network } : {}),
    ...(extensions ? { extensions } : {}),
    ...(podSpec ? { podSpec } : {}),
    ...(instanceLimit ? { instanceLimit } : {}),
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
    const template = z.custom<SandboxTemplate>().parse(storeEntry.value);
    return { source: 'store', template };
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
    const entry = await atomic.get<Record<string, unknown>>(PREFIX + t.id);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- atomic.get returns T | null
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
  const enterPhase: 'enter' = 'enter';
  const stack: { id: string; phase: 'enter' | 'exit' }[] = seedIds.map(id => ({ id, phase: enterPhase }));

  while (stack.length) {
    const frame = stack.pop()!;
    if (frame.phase === 'exit') {
      visited.add(frame.id);
      inStack.delete(frame.id);
      continue;
    }
    if (inStack.has(frame.id)) {
      throw new AppError(400, 'CYCLE_DETECTED', `Cycle detected: template "${frame.id}" depends on itself (directly or transitively)`);
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
export function deepMerge(parent: Record<string, unknown>, child: Record<string, unknown>): Record<string, unknown> {
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

function mergeByName(parent: Record<string, unknown>[] | undefined, child: Record<string, unknown>[] | undefined): Record<string, unknown>[] {
  if (!child) return parent ?? [];
  if (!parent) return child;
  const map = new Map<string, Record<string, unknown>>();
  for (const item of parent) map.set(item.name, item);
  for (const item of child) {
    const existing = map.get(item.name);
    if (existing) map.set(item.name, deepMerge(existing, item));
    else map.set(item.name, item);
  }
  return [...map.values()];
}

function mergeHealthChecks(parent: Record<string, unknown>[] | undefined, child: Record<string, unknown>[] | undefined): Record<string, unknown>[] {
  if (!child) return parent ?? [];
  if (!parent) return child;
  const keyFn = (h: Record<string, unknown>): string => `${String(h.target)}:${String(h.name)}`;
  const map = new Map<string, Record<string, unknown>>();
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
  if (!tpl) throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'Template not found');

  const chain = resolveDag(allTemplates, [id]).reverse();
  const chainIds = chain.map(t => t.id);
  let mergedSpec: Record<string, unknown> = {};
  for (const t of chain) {
    mergedSpec = deepMerge(mergedSpec, {
      ...(t.container ? { container: t.container } : {}),
      ...(t.healthChecks ? { healthChecks: t.healthChecks } : {}),
      ...(t.network ? { network: t.network } : {}),
      ...(t.extensions ? { extensions: t.extensions } : {}),
      ...(t.podSpec ? { podSpec: t.podSpec } : {}),
    });
  }
  return { template: { ...tpl, ...mergedSpec }, chain: chainIds };
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
    const entry = await atomic.get<Record<string, unknown>>(SANDBOX_PREFIX + sid);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- atomic.get returns T | null, tsc narrows inconsistently
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
      throw new AppError(429, 'TEMPLATE_SINGLETON', `Template "${tpl.name}" is singleton — only 1 instance allowed at a time (${String(runningCount)} running)`);
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
      throw new AppError(429, 'TEMPLATE_LIMIT', `Template "${tpl.name}" has ${String(runningCount)} running instance(s) — limit is ${String(max)}`);
    }
    const entry = await atomic.get<number>(baseKey);
    await atomic.set(baseKey, (entry?.value ?? 0) + 1, entry?.version ?? null);
    return;
  }

  const idx = await atomic.get<string[]>(SANDBOX_INDEX_KEY);
  let userCount = 0;
  if (idx) {
    for (const sid of idx.value) {
      const entry = await atomic.get<Record<string, unknown>>(SANDBOX_PREFIX + sid);
      if (entry.value.config.templateRef === tpl.id
          && LIVE_STATUSES.includes(entry.value.status)
          && entry.value.config.creatorId === userId) {
        userCount++;
      }
    }
  }
    if (userCount >= max) {
    throw new AppError(429, 'TEMPLATE_PER_USER_LIMIT', `Template "${tpl.name}" per-user limit of ${String(max)} reached (${String(userCount)} running)`);
  }
  const entry = await atomic.get<number>(userKey);
  await atomic.set(userKey, (entry?.value ?? 0) + 1, entry?.version ?? null);
  return;
}

function bindingKey(domain: string, port: number): string { return `tpl:bind:${domain}:${String(port)}`; }

async function claimResourceBinding(
  atomic: IAtomicStore,
  tpl: SandboxTemplate,
): Promise<void> {
  const binding = tpl.resourceBinding;
  if (!binding?.domain || !binding.port) return;

  const key = bindingKey(binding.domain, binding.port);
  const entry = await atomic.get<string>(key);
  if (entry) {
    throw new AppError(409, 'RESOURCE_BOUND', `Domain ${binding.domain}:${String(binding.port)} is already bound to another instance`);
  }
  await atomic.set(key, tpl.id, null);
}

async function releaseResourceBinding(atomic: IAtomicStore, tpl: SandboxTemplate): Promise<void> {
  const binding = tpl.resourceBinding;
  if (!binding?.domain || !binding.port) return;
  const key = bindingKey(binding.domain, binding.port);
  const entry = await atomic.get<string>(key);
  try { if (entry) await atomic.set(key, null, entry.version); } catch {
    console.debug("noop");
  }
}

async function releaseInstanceSlot(atomic: IAtomicStore, tpl: SandboxTemplate, _userId: string): Promise<void> {
  if (!tpl.singleton && !tpl.instanceLimit) return;
  const baseKey = lockKey(tpl.id);
  const entry = await atomic.get<number>(baseKey);
  if (entry && entry.value > 0) {
    try { await atomic.set(baseKey, entry.value - 1, entry.version); } catch {
      console.debug("noop");
    }
  }
  if (tpl.instanceLimit?.type === 'perUser') {
    const userKey = lockKey(tpl.id, ':' + _userId);
    const uEntry = await atomic.get<number>(userKey);
    if (uEntry && uEntry.value > 0) {
      try { await atomic.set(userKey, uEntry.value - 1, uEntry.version); } catch {
        console.debug("noop");
      }
    }
  }
}

function canAccessTemplate(tpl: SandboxTemplate, user: { id: string; role?: string } | undefined): boolean {
  if (isUserRoot(user)) return true;
  if (!tpl.visibility || tpl.visibility === TemplateVisibility.PUBLIC) return true;
  return tpl.creatorId === user?.id;
}

// ─── Router ───

export function createTemplateRouter(atomic: IAtomicStore, sandboxService?: ISandboxService, providers?: IProviderRegistry, permissionChecker?: PermissionCheckFn): OpenAPIHono<{ Variables: AppContext }> {
  const app = new OpenAPIHono<{ Variables: AppContext }>();

  // POST / — 创建模板
  app.openapi(createRoute({ method: 'post', path: '/', tags: ['templates'], summary: '创建模板', responses: { 201: { description: 'SandboxTemplate', content: { 'application/json': { schema: OkResponse(SandboxTemplateSchema) } } } } }), async (c) => {
      await requirePerm(c, permissionChecker, 'create', 'template');
      const bodySchema = z.object({
        name: z.string().optional(),
        healthChecks: z.array(z.object({ type: z.string() })).optional(),
        singleton: z.boolean().optional(),
        instanceLimit: z.unknown().optional(),
        description: z.string().optional(),
        apiVersion: z.string().optional(),
        kind: z.string().optional(),
        metadata: z.unknown().optional(),
        dependsOn: z.array(z.string()).optional(),
        resourceBinding: z.unknown().optional(),
        container: z.unknown().optional(),
        network: z.unknown().optional(),
        extensions: z.unknown().optional(),
        podSpec: z.unknown().optional(),
      }).passthrough();
      const body = bodySchema.parse(await c.req.json());
      if (!body.name) throw new AppError(400, 'VALIDATION_ERROR', 'name is required');

      const user = c.var.currentUser;
      if (!isUserRoot(user) && body.healthChecks) {
        body.healthChecks = body.healthChecks.filter(h => h.type !== 'liveness');
      }

      if (body.singleton && body.instanceLimit) {
        throw new AppError(400, 'VALIDATION_ERROR', 'singleton and instanceLimit are mutually exclusive');
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
      c.var.audit.write({
        level: KernLevel.NOTICE,
        facility: 'template',
        message: `Template created — ${tpl.name}`,
        metadata: { eventType: 'template.created', templateId: tpl.id, actorId: user?.id },
      });
      return c.json(ok(tpl), 201);
    });

  // GET / —
  app.openapi(createRoute({ method: 'get', path: '/', tags: ['templates'], summary: '列出所有模板', responses: { 200: { description: 'SandboxTemplate[]', content: { 'application/json': { schema: PaginatedResponse(SandboxTemplateSchema) } } } } }), async (c) => {
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
    });

  // GET /:id
  app.openapi(createRoute({ method: 'get', path: '/{id}', tags: ['templates'], summary: '获取模板', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'SandboxTemplate', content: { 'application/json': { schema: OkResponse(SandboxTemplateSchema) } } } } }), async (c) => {
    const resolved = await resolveTemplateSource(atomic, c.req.param('id'));
    if (!resolved) throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'Template not found');
    const user = c.var.currentUser;
    if (!canAccessTemplate(resolved.template, user)) {
      throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'Template not found');
    }
    return c.json(ok(resolved.template));
  });

  // PUT /:id
  app.openapi(createRoute({ method: 'put', path: '/{id}', tags: ['templates'], summary: '更新模板', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'SandboxTemplate', content: { 'application/json': { schema: OkResponse(SandboxTemplateSchema) } } } } }), async (c) => {
    const id = c.req.param('id');
    const user = c.var.currentUser;
    const resolved = await resolveTemplateSource(atomic, id);
    if (!resolved) throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'Template not found');

    if (resolved.source === 'generated' && !isUserRoot(user)) {
      throw new AppError(403, 'FORBIDDEN', 'Only root can modify built-in templates');
    }
    if (resolved.source === 'store' && !isUserRoot(user) && resolved.template.creatorId !== user?.id) {
      throw new AppError(403, 'FORBIDDEN', 'Not your template');
    }

    const body = await z.unknown().parse(c.req.json());
    if (body.singleton && body.instanceLimit) {
      throw new AppError(400, 'VALIDATION_ERROR', 'singleton and instanceLimit are mutually exclusive');
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
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- atomic.get returns T | null
      if (!idx?.value?.includes(id)) {
        await atomic.set(INDEX_KEY, [...(idx?.value ?? []), id], idx?.version ?? null);
      }
    }
    c.var.audit.write({
      level: KernLevel.INFO,
      facility: 'template',
      message: `Template ${resolved.source === 'generated' ? 'overridden' : 'updated'} — ${updated.name}`,
      metadata: { eventType: 'template.updated', templateId: id, source: resolved.source, actorId: user?.id },
    });
    return c.json(ok(updated));
  });

  // DELETE /:id
  app.openapi(createRoute({ method: 'delete', path: '/{id}', tags: ['templates'], summary: '删除模板', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: OkResponse(z.union([TemplateDeleteResponseSchema, z.null()])) } } } } }), async (c) => {
    const id = c.req.param('id');
    const user = c.var.currentUser;
    const resolved = await resolveTemplateSource(atomic, id);
    if (!resolved) throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'Template not found');

    if (resolved.source === 'generated') {
      if (!isUserRoot(user)) {
        throw new AppError(403, 'FORBIDDEN', 'Only root can delete built-in templates');
      }
      const now = Date.now();
      await atomic.set(PREFIX + id, {
        __deleted: true,
        deletedBy: user?.id,
        deletedAt: now,
        __originalId: id,
      }, null);
      c.var.audit.write({
        level: KernLevel.WARNING,
        facility: 'template',
        message: `Template masked — ${resolved.template.name} (tombstone)`,
        metadata: { eventType: 'template.masked', templateId: id, actorId: user?.id },
      });
      return c.json(ok({ masked: true, id }));
    }

    const entry = await atomic.get<SandboxTemplate>(PREFIX + id);
    if (!entry) throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'Template not found');
    if (!entry.value.creatorId) {
      throw new AppError(403, 'FORBIDDEN', `Cannot delete seed template "${entry.value.name}" — protected by system policy`);
    }
    if (!isUserRoot(user) && entry.value.creatorId !== user?.id) {
      throw new AppError(403, 'FORBIDDEN', 'Not your template');
    }
    await atomic.set(PREFIX + id, null, entry.version);
    const idx = await atomic.get<string[]>(INDEX_KEY);
    if (idx) await atomic.set(INDEX_KEY, idx.value.filter((i: string) => i !== id), idx.version);
    c.var.audit.write({
      level: KernLevel.WARNING,
      facility: 'template',
      message: `Template deleted — ${entry.value.name}`,
      metadata: { eventType: 'template.deleted', templateId: id, actorId: user?.id },
    });
    return c.json(ok(null));
  });

  // GET /:id/resolved
  app.openapi(createRoute({ method: 'get', path: '/{id}/resolved', tags: ['templates'], summary: '获取模板解析结果', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'SandboxTemplate with _chain', content: { 'application/json': { schema: OkResponse(ResolvedTemplateSchema) } } } } }), async (c) => {
    try {
      const { template: resolved, chain } = await resolveTemplateWithChain(atomic, c.req.param('id'));
      const user = c.var.currentUser;
      if (!canAccessTemplate(resolved, user)) {
        throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'Template not found');
      }
      return c.json(ok({ ...resolved, _chain: chain }));
    } catch (e: unknown) {
      if (e instanceof AppError) {
        console.error(`[template] resolve failed for ${c.req.param('id')}:`, e);
        throw e;
      }
      throw new AppError(500, 'INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
    }
  });

  // POST /:id/apply
  app.openapi(createRoute({ method: 'post', path: '/{id}/apply', tags: ['templates'], summary: '应用模板', request: { params: z.object({ id: z.string() }) }, responses: { 201: { description: 'Sandbox', content: { 'application/json': { schema: OkResponse(SandboxSchema) } } } } }), async (c) => {
    await requirePerm(c, permissionChecker, 'create', 'sandbox');
    let resolved;
    try {
      resolved = await resolveTemplate(atomic, c.req.param('id'));
      const body = await z.object({ provider: z.string().optional(), instanceId: z.string().optional(), region: z.string().optional(), name: z.string().optional() }).parse(c.req.json());

      const user = c.var.currentUser;

      if (!canAccessTemplate(resolved, user)) {
        throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'Template not found');
      }

      await claimInstanceSlot(atomic, resolved, user?.id ?? 'anonymous');
      await claimResourceBinding(atomic, resolved);

      if (resolved.kind === 'ContainerGroup' && resolved.podSpec) {
        const baseInput = podSpecToSandboxInput(resolved.podSpec);
        const input = { ...baseInput, apiVersion: 'hbi-aad/v2', templateRef: resolved.id, ...(user?.id ? { creatorId: user.id } : {}) };

        const explicitInstanceId: string | undefined = body.instanceId ?? resolved.podSpec.instanceId;
        const targetRegion: string | undefined = body.region ?? resolved.podSpec.region ?? baseInput.region;
        let svc = sandboxService;
        let resolvedInstanceId: string | undefined;

        if (explicitInstanceId && providers?.resolveContainer) {
          const instProvider = await providers.resolveContainer(explicitInstanceId);
          svc = new SandboxService(atomic, new ConsoleLogger(), instProvider, providers, undefined, undefined, createAtomicNetworkResolver(atomic), new InstanceService(atomic));
          resolvedInstanceId = explicitInstanceId;
        } else if (providers && targetRegion) {
          const instSvc = new InstanceService(atomic);
          const allInst = await instSvc.resolveByCapability('container');
          const match = allInst.find(i => i.status === 'online' && i.region === targetRegion);
          if (match) {
            const instProvider = await providers.resolveContainer(match.id);
            svc = new SandboxService(atomic, new ConsoleLogger(), instProvider, providers, undefined, undefined, createAtomicNetworkResolver(atomic), instSvc);
            resolvedInstanceId = match.id;
          }
        }

        const finalInput = resolvedInstanceId
          ? { ...input, instanceId: z.custom<InstanceId>().parse(resolvedInstanceId) }
          : input;

        if (!svc) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Sandbox service not available');
        const sandbox = await svc.provision(finalInput);
        c.var.audit.write({
          level: KernLevel.NOTICE,
          facility: 'template',
          message: `Template applied (v2) — ${resolved.name} → sandbox ${sandbox.id}`,
          metadata: { eventType: 'template.applied.v2', templateId: resolved.id, sandboxId: sandbox.id, actorId: user?.id },
        });
        return c.json(ok(sandbox), 201);
      }

      const providerName = body.provider;
      const explicitInstanceId: string | undefined = body.instanceId ?? resolved.container?.instanceId;
      const targetRegion: string | undefined = body.region ?? resolved.container?.region;
      let svc = sandboxService;
      let resolvedInstanceId: string | undefined;

      if (explicitInstanceId && providers?.resolveContainer) {
        const instProvider = await providers.resolveContainer(explicitInstanceId);
        svc = new SandboxService(atomic, new ConsoleLogger(), instProvider, providers, undefined, undefined, createAtomicNetworkResolver(atomic), new InstanceService(atomic));
        resolvedInstanceId = explicitInstanceId;
      } else if (providers && targetRegion) {
        const instSvc = new InstanceService(atomic);
        const allInst = await instSvc.resolveByCapability('container');
        const match = allInst.find(i => i.status === 'online' && i.region === targetRegion);
        if (match) {
          const instProvider = await providers.resolveContainer(match.id);
          svc = new SandboxService(atomic, new ConsoleLogger(), instProvider, providers, undefined, undefined, createAtomicNetworkResolver(atomic), instSvc);
          resolvedInstanceId = match.id;
        }
      } else if (providerName && providers) {
        const entry = providers.provider(providerName);
        if (!entry) throw new AppError(400, 'PROVIDER_NOT_FOUND', `Provider "${String(providerName)}" not available`);
        svc = new SandboxService(atomic, new ConsoleLogger(), entry.container, providers, undefined, undefined, createAtomicNetworkResolver(atomic), new InstanceService(atomic));
      }
      if (!svc) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Sandbox service not available');

      const baseInput = await applyTemplate(resolved, body.name, body.region, async (volumeId) => {
        const volEntry = await atomic.get<Record<string, unknown>>('volume:' + volumeId);
        return volEntry?.value ?? null;
      });
      const input = resolvedInstanceId
        ? { ...baseInput, instanceId: z.custom<InstanceId>().parse(resolvedInstanceId) }
        : baseInput;

      const sandbox = await svc.provision(
        user?.id ? { ...input, creatorId: user.id } : input,
      );
      c.var.audit.write({
        level: KernLevel.NOTICE,
        facility: 'template',
        message: `Template applied — ${resolved.name} → sandbox ${sandbox.id}`,
        metadata: { eventType: 'template.applied', templateId: resolved.id, sandboxId: sandbox.id, actorId: user?.id },
      });
      return c.json(ok(sandbox), 201);
    } catch (e: unknown) {
      console.error(`[template] apply failed for ${c.req.param('id')}:`, e);
      if (resolved) {
        try { await releaseInstanceSlot(atomic, resolved, c.var.currentUser?.id ?? 'anonymous'); } catch {
          console.debug("noop");
        }
        try { await releaseResourceBinding(atomic, resolved); } catch {
          console.debug("noop");
        }
      }
      if (e instanceof AppError) throw e;
      throw new AppError(500, 'INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
    }
  });

  return app;
}

export { resolveTemplate };

