import { z } from 'zod';
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { IAtomicStore } from '../../core/store/interfaces.ts';
import { ok } from '../../core/response.ts';
import { OkResponse, PaginatedResponse } from '../../core/http-docs/response-schema.ts';
import { TemplateSchema, ResolvedTemplateSchema, TemplateDeleteResponseSchema } from './response-schema.ts';
import { PodCreateResponseSchema } from '../pod/response-schema.ts';
import { AppError } from '../../core/types.ts';
import type { AppContext } from '../../core/deps.ts';
import type { Template, TemplateInstanceLimit } from './types.ts';
import { KernLevel } from '../../core/audit/kern-level.ts';
import { TemplateVisibility } from './types.ts';
import type { IProviderRegistry } from '../../core/provider/interfaces.ts';
import type { PodService } from '../../core/pod/service.ts';
import type { PodSpec } from '../../core/pod/types.ts';
import { PodSpecSchema } from '../../core/pod/schema.ts';
import { mergePodSpec } from '../../core/pod/merge.ts';
import { UserRole } from '../users/types.ts';
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

const PREFIX = 'tpl:';
const INDEX_KEY = 'tpl:ids';

function genId(): string { return `tpl_${crypto.randomUUID()}`; }

/** Convert a YAML-generated InstanceTemplateDef to the new Template shape. */
function fromGeneratedTemplate(def: InstanceTemplateDef): Template {
  const now = Date.now();
  const s = def.spec as Record<string, unknown>;

  const dependsOn = z.array(z.string()).optional().parse(s.dependsOn);
  const singleton = z.boolean().optional().parse(s.singleton);
  const instanceLimit = z.custom<TemplateInstanceLimit>().optional().parse(s.instanceLimit);

  // spec field is core PodSpec (from YAML, pre-validated at build time)
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- generated template data, validated at build time
  const podSpec = s.spec as PodSpec;

  return {
    id: def.id,
    name: def.name,
    description: def.description,
    apiVersion: z.string().parse(s.apiVersion ?? 'hbi-aad/v1'),
    kind: 'Pod' as const,
    spec: podSpec,
    ...(dependsOn?.length ? { dependsOn } : {}),
    createdAt: now,
    updatedAt: now,
    ...(singleton !== undefined ? { singleton } : {}),
    ...(instanceLimit !== undefined ? { instanceLimit } : {}),
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- generated template construction; validated at build time
  } as Template;
}

/** Generated templates (YAML source-of-truth) as Template shape. */
function listGenerated(): Template[] {
  return INSTANCE_TEMPLATES.map(d => fromGeneratedTemplate(d));
}

// ─── systemd-style layered template resolution ───

interface ResolvedTemplate {
  source: 'generated' | 'store';
  template: Template;
}

/** Resolve a template by ID using systemd-style layering. */
async function resolveTemplateSource(atomic: IAtomicStore, id: string): Promise<ResolvedTemplate | null> {
  const storeEntry = await atomic.get<Record<string, unknown>>(PREFIX + id);
  if (storeEntry) {
    if (storeEntry.value.__deleted === true) return null;
    const template = z.custom<Template>().parse(storeEntry.value);
    return { source: 'store', template };
  }
  const gen = INSTANCE_TEMPLATES.find(d => d.id === id);
  if (gen) return { source: 'generated', template: fromGeneratedTemplate(gen) };
  return null;
}

/** List all live templates: generated (non-tombstoned) + store overrides/store-only. */
async function listAllLive(atomic: IAtomicStore): Promise<Template[]> {
  const generated = listGenerated();
  const stored = await listStored(atomic);
  const map = new Map<string, Template>();
  for (const t of generated) map.set(t.id, t);
  for (const t of stored) map.set(t.id, t);
  const result: Template[] = [];
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

function resolveDag(tpls: Template[], seedIds: string[]): Template[] {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const result: Template[] = [];
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

async function resolveTemplate(atomic: IAtomicStore, id: string): Promise<Template> {
  const result = await resolveTemplateWithChain(atomic, id);
  return result.template;
}

async function resolveTemplateWithChain(atomic: IAtomicStore, id: string): Promise<{ template: Template; chain: readonly string[] }> {
  const allTemplates = await listAllLive(atomic);
  const tpl = allTemplates.find(t => t.id === id);
  if (!tpl) throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'Template not found');

  const chain = resolveDag(allTemplates, [id]).reverse();
  const chainIds = chain.map(t => t.id);

  // DAG merge: sequentially merge each ancestor's PodSpec
  let mergedSpec: PodSpec = tpl.spec;
  for (const t of chain) {
    if (t.id === id) continue;
    mergedSpec = mergePodSpec(mergedSpec, t.spec);
  }

  return { template: { ...tpl, spec: mergedSpec }, chain: chainIds };
}

async function listStored(atomic: IAtomicStore): Promise<Template[]> {
  const idx = await atomic.get<string[]>(INDEX_KEY);
  if (!idx) return [];
  const entries = await Promise.all(idx.value.map(id => atomic.get<Template>(PREFIX + id)));
  return entries.filter(e => e).map(e => e!.value);
}

// ─── Instance limit enforcement ───

function lockKey(tplId: string, suffix = ''): string {
  let h = 5381;
  for (let i = 0; i < tplId.length; i++) h = ((h << 5) + h) + tplId.charCodeAt(i);
  return `tpl:lock:${Math.abs(h).toString(36)}${suffix}`;
}

const POD_INDEX_KEY = 'pod:ids';
const POD_PREFIX = 'pod:';

// PodPhase: Pending/Running = active; Succeeded/Failed = terminal
const LIVE_POD_PHASES = new Set(['Pending', 'Running']);

async function countRunningForTemplate(atomic: IAtomicStore, tplId: string): Promise<number> {
  const idx = await atomic.get<string[]>(POD_INDEX_KEY);
  if (!idx) return 0;
  let count = 0;
  for (const pid of idx.value) {
    const entry = await atomic.get<Record<string, unknown>>(POD_PREFIX + pid);
    if (entry?.value?.templateRef === tplId && LIVE_POD_PHASES.has(entry.value.phase)) {
      count++;
    }
  }
  return count;
}

async function claimInstanceSlot(
  atomic: IAtomicStore,
  tpl: Template,
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

  const idx = await atomic.get<string[]>(POD_INDEX_KEY);
  let userCount = 0;
  if (idx) {
    for (const pid of idx.value) {
      const entry = await atomic.get<Record<string, unknown>>(POD_PREFIX + pid);
      if (entry.value.templateRef === tpl.id
          && LIVE_POD_PHASES.has(entry.value.phase)
          && entry.value.creatorId === userId) {
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
  tpl: Template,
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


function canAccessTemplate(tpl: Template, user: { id: string; role?: string } | undefined): boolean {
  if (isUserRoot(user)) return true;
  if (!tpl.visibility || tpl.visibility === TemplateVisibility.PUBLIC) return true;
  return tpl.creatorId === user?.id;
}

// ─── Router ───

export function createTemplateRouter(atomic: IAtomicStore, podSvc: PodService, _providers?: IProviderRegistry, permissionChecker?: PermissionCheckFn): OpenAPIHono<{ Variables: AppContext }> {
  const app = new OpenAPIHono<{ Variables: AppContext }>();

  // POST / — 创建模板
  app.openapi(createRoute({ method: 'post', path: '/', tags: ['templates'], summary: '创建模板', responses: { 201: { description: 'Template', content: { 'application/json': { schema: OkResponse(TemplateSchema) } } } } }), async (c) => {
      await requirePerm(c, permissionChecker, 'create', 'template');
      const bodySchema = z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        apiVersion: z.string().optional(),
        kind: z.enum(['Pod']).optional(),
        spec: PodSpecSchema,
        dependsOn: z.array(z.string()).optional(),
        singleton: z.boolean().optional(),
        instanceLimit: z.object({
          type: z.enum(['fixed', 'perUser', 'perSystem']),
          max: z.number(),
        }).optional(),
        resourceBinding: z.object({
          domain: z.string().optional(),
          port: z.number().optional(),
        }).optional(),
        metadata: z.object({
          labels: z.record(z.string(), z.string()).optional(),
          annotations: z.record(z.string(), z.string()).optional(),
        }).optional(),
      }).passthrough();
      const body = bodySchema.parse(await c.req.json());

      const user = c.var.currentUser;

      if (body.singleton && body.instanceLimit) {
        throw new AppError(400, 'VALIDATION_ERROR', 'singleton and instanceLimit are mutually exclusive');
      }

      const now = Date.now();
      const tpl: Template = {
        id: genId(),
        name: body.name,
        description: body.description,
        apiVersion: body.apiVersion || 'hbi-aad/v1',
        kind: 'Pod',
        metadata: body.metadata,
        dependsOn: body.dependsOn,
        creatorId: user?.id,
        createdAt: now,
        updatedAt: now,
        visibility: undefined,
        singleton: body.singleton,
        instanceLimit: body.instanceLimit,
        resourceBinding: body.resourceBinding,
        spec: body.spec,
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
  app.openapi(createRoute({ method: 'get', path: '/', tags: ['templates'], summary: '列出所有模板', responses: { 200: { description: 'Template[]', content: { 'application/json': { schema: PaginatedResponse(TemplateSchema) } } } } }), async (c) => {
      const user = c.var.currentUser;
      const page = parseInt(c.req.query('page') ?? '') || 1;
      const limit = parseInt(c.req.query('limit') ?? '') || 50;
      const name = c.req.query('name');

      let visible = await listAllLive(atomic);
      if (user) visible = visible.filter(t => canAccessTemplate(t, user));
      if (name) visible = visible.filter(t => t.name.toLowerCase().includes(name.toLowerCase()));

      const total = visible.length;
      const start = (page - 1) * limit;
      const items = visible.slice(start, start + limit);
      return c.json(ok({ items, total, page, limit }));
    });

  // GET /:id
  app.openapi(createRoute({ method: 'get', path: '/{id}', tags: ['templates'], summary: '获取模板', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Template', content: { 'application/json': { schema: OkResponse(TemplateSchema) } } } } }), async (c) => {
    const resolved = await resolveTemplateSource(atomic, c.req.param('id'));
    if (!resolved) throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'Template not found');
    const user = c.var.currentUser;
    if (!canAccessTemplate(resolved.template, user)) {
      throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'Template not found');
    }
    return c.json(ok(resolved.template));
  });

  // PUT /:id
  app.openapi(createRoute({ method: 'put', path: '/{id}', tags: ['templates'], summary: '更新模板', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Template', content: { 'application/json': { schema: OkResponse(TemplateSchema) } } } } }), async (c) => {
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
    const updated: Template = {
      ...base,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description ?? undefined } : {}),
      ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      ...(body.singleton !== undefined ? { singleton: body.singleton } : {}),
      ...(body.instanceLimit !== undefined ? { instanceLimit: body.instanceLimit ?? undefined } : {}),
      ...(body.resourceBinding !== undefined ? { resourceBinding: body.resourceBinding ?? undefined } : {}),
      ...(body.spec !== undefined ? { spec: body.spec } : {}),
      ...(body.dependsOn !== undefined ? { dependsOn: body.dependsOn ?? [] } : {}),
      updatedAt: Date.now(),
      ...(resolved.source === 'generated' ? { __originalGenerated: true } : {}),
    };

    const existingVersion = resolved.source === 'store'
      ? (await atomic.get<Template>(PREFIX + id))?.version
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

    const entry = await atomic.get<Template>(PREFIX + id);
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
  app.openapi(createRoute({ method: 'get', path: '/{id}/resolved', tags: ['templates'], summary: '获取模板解析结果', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Template with _chain', content: { 'application/json': { schema: OkResponse(ResolvedTemplateSchema) } } } } }), async (c) => {
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
  app.openapi(createRoute({ method: 'post', path: '/{id}/apply', tags: ['templates'], summary: '应用模板', request: { params: z.object({ id: z.string() }) }, responses: { 201: { description: 'Pod created', content: { 'application/json': { schema: OkResponse(PodCreateResponseSchema) } } } } }), async (c) => {
    await requirePerm(c, permissionChecker, 'create', 'sandbox');
    const resolved = await resolveTemplate(atomic, c.req.param('id'));

    const user = c.var.currentUser;

    if (!canAccessTemplate(resolved, user)) {
      throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'Template not found');
    }

    await claimInstanceSlot(atomic, resolved, user?.id ?? 'anonymous');
    await claimResourceBinding(atomic, resolved);

    const pod = await podSvc.provision(resolved.spec, {
      creatorId: user?.id,
      templateRef: resolved.id,
    });

    c.var.audit.write({
      level: KernLevel.NOTICE,
      facility: 'template',
      message: `Template applied — ${resolved.name} → pod ${pod.podId}`,
      metadata: { eventType: 'template.applied', templateId: resolved.id, podId: pod.podId, actorId: user?.id },
    });

    return c.json(ok({
      podId: pod.podId,
      providerId: pod.providerId,
      phase: pod.phase,
      name: pod.name,
    }), 201);
  });

  return app;
}

export { resolveTemplate };

