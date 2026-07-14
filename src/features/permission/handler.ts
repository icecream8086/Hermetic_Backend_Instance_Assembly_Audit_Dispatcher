import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import type { Context } from 'hono';
import type { AppContext } from '../../core/deps.ts';
import type { IPermissionService } from './service.ts';
import {
  CreatePolicySchema,
  UpdatePolicySchema,
  PermissionCheckSchema,
  CreateUserGroupSchema,
  UpdateUserGroupSchema,
  CreatePermGroupSchema,
  UpdatePermGroupSchema,
  CreateRouteAclSchema,
  UpdateRouteAclSchema,
  CreateUserTplSchema,
  UpdateUserTplSchema,
  CreateInviteSchema,
} from './schema.ts';
import { ok, fail } from '../../core/response.ts';
import { OkResponse } from '../../core/http-docs/response-schema.ts';
import {
  TemplateSchema, InvitationSchema,
  UserCapsSchema, UserCapsResultSchema, GroupCapsSchema, GroupCapsResultSchema,
  ElevationGrantSchema, ElevationEntrySchema, CompareResultSchema,
  PolicyMatchResultSchema,
} from './response-schema.ts';
import type { ErrorCode } from '../../core/error-codes.ts';
import type { LogPolicy } from './types.ts';
import { AppError } from '../../core/types.ts';
import type { AuditActor } from './audit.ts';
import type { CrudHandlerMap } from '../../core/crud/router.ts';
import { registerCrudRoutes } from '../../core/crud/router.ts';
import type { PaginatedResult } from '../../core/crud/types.ts';

const KernLevelNames = z.enum([
  'emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug', 'none',
]);

const KNOWN_FACILITIES = [
  'user-service', 'perm', 'perm-audit', 'authz', 'sysgrp',
  'sandbox-service', 'template', 'dns-service', 'quota', 'http',
  'subnet', 'secgroup', 'system',
] as const;

const UpdateLogPolicySchema = z.object({
  defaultLevel: KernLevelNames.optional(),
  auditLevel: KernLevelNames.optional(),
  facilities: z.array(z.object({
    facility: z.enum(KNOWN_FACILITIES),
    level: KernLevelNames,
  })).optional(),
});

type Ctx = Context<{ Variables: AppContext }>;

function actorFrom(c: Ctx): AuditActor | undefined {
  const u = c.var.currentUser;
  if (!u) return undefined;
  return { userId: u.id, ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() };
}

function requireRoot(c: Ctx): null {
  const user = c.var.currentUser;
  if (!user) return null;
  const isRoot = user.role === 'root' || user.role === 'Operator' || user.role === 'wheel';
  if (!isRoot) throw new AppError(403, 'FORBIDDEN', 'Admin access required');
  return null;
}

function requireWheel(c: Ctx): null {
  const user = c.var.currentUser;
  if (!user) return null;
  if (user.role !== 'wheel') throw new AppError(403, 'FORBIDDEN', 'Wheel privilege required');
  return null;
}

// ─── CRUD sub-resource factory ───

interface SubCrudOpts<T, I_Create extends Record<string, unknown> = Record<string, unknown>, I_Update extends Record<string, unknown> = Record<string, unknown>> {
  guard: (c: Ctx) => null;
  createSchema: z.ZodType<I_Create>;
  createFn: (data: I_Create, actor: AuditActor | undefined) => Promise<T>;
  listUrlFilter: (c: Ctx) => ((item: T) => boolean) | undefined;
  listFn: (page: number, limit: number, filter: ((item: T) => boolean) | undefined) => Promise<PaginatedResult<T>>;
  getFn: (id: string) => Promise<T | null>;
  updateSchema: z.ZodType<I_Update>;
  updateFn: (id: string, data: I_Update, actor: AuditActor | undefined) => Promise<T>;
  deleteFn: (id: string, actor: AuditActor | undefined) => Promise<void>;
  notFoundCode: ErrorCode;
  notFoundMsg: string;
}

/** Build a CrudHandlerMap for a sub-resource. TypeScript enforces all 5 actions are present. */
function subCrud<T, I_Create extends Record<string, unknown> = Record<string, unknown>, I_Update extends Record<string, unknown> = Record<string, unknown>>(opts: SubCrudOpts<T, I_Create, I_Update>): CrudHandlerMap {
  return {
    create: (r) => r.post('/', async (c) => {
      opts.guard(c);
      const raw = await c.req.json();
      const data = opts.createSchema.parse(raw);
      const result = await opts.createFn(data, actorFrom(c));
      return c.json(ok(result), 201);
    }),

    list: (r) => r.get('/', async (c) => {
      const page = parseInt(c.req.query('page') ?? '') || 1;
      const limit = parseInt(c.req.query('limit') ?? '') || 50;
      const filter = opts.listUrlFilter(c);
      return c.json(ok(await opts.listFn(page, limit, filter)));
    }),

    get: (r) => r.get('/:id', async (c) => {
      const result = await opts.getFn(c.req.param('id'));
      if (!result) return c.json(fail(opts.notFoundCode, opts.notFoundMsg), 404);
      return c.json(ok(result));
    }),

    update: (r) => r.put('/:id', async (c) => {
      opts.guard(c);
      const raw = await c.req.json();
      const data = opts.updateSchema.parse(raw);
      return c.json(ok(await opts.updateFn(c.req.param('id'), data, actorFrom(c))));
    }),

    delete: (r) => r.delete('/:id', async (c) => {
      opts.guard(c);
      await opts.deleteFn(c.req.param('id'), actorFrom(c));
      return c.json(ok(null));
    }),
  };
}

// ─── Name-based filter helper ───

function nameFilter<T extends { name?: string | null }>(c: Ctx): ((item: T) => boolean) | undefined {
  const name = c.req.query('name');
  return name ? (item: T) => (item.name ?? '').toLowerCase().includes(name.toLowerCase()) : undefined;
}

function queryFilter<T extends { pathPrefix?: string | null; method?: string | null }>(key: string) {
  return (c: Ctx): ((item: T) => boolean) | undefined => {
    const q = c.req.query(key);
     
    return q ? (item: T) => (item.pathPrefix ?? '').toLowerCase().includes(q.toLowerCase()) || (item.method ?? '').toLowerCase().includes(q.toLowerCase()) : undefined;
  };
}

// ═══════════════════════════════════════════════════════════════
// Main router
// ═══════════════════════════════════════════════════════════════

export function createPermissionRouter(svc: IPermissionService): OpenAPIHono<{ Variables: AppContext }> {
  const app = new OpenAPIHono<{ Variables: AppContext }>();

  // ─── Policies CRUD ───
  {
    const policies = new OpenAPIHono();
    registerCrudRoutes(policies, subCrud({
      guard: requireRoot,
      createSchema: CreatePolicySchema,
      createFn: (data, actor) => svc.createPolicy(data, actor),
      listUrlFilter: nameFilter,
      listFn: (page, limit, filter) => svc.listPoliciesPaginated(page, limit, filter),
      getFn: (id) => svc.getPolicy(id),
      updateSchema: UpdatePolicySchema,
      updateFn: (id, data, actor) => svc.updatePolicy(id, data, actor),
      deleteFn: (id, actor) => svc.deletePolicy(id, actor),
      notFoundCode: 'POLICY_NOT_FOUND',
      notFoundMsg: 'Policy not found',
    }));
    app.route('/policies', policies);
    app.route('/policies/', policies);
  }

  // ─── User groups CRUD ───
  {
    const userGroups = new OpenAPIHono();
    registerCrudRoutes(userGroups, subCrud({
      guard: requireWheel,
      createSchema: CreateUserGroupSchema,
      createFn: (data, actor) => svc.createUserGroup(data, actor),
      listUrlFilter: nameFilter,
      listFn: (page, limit, filter) => svc.listUserGroupsPaginated(page, limit, filter),
      getFn: (id) => svc.getUserGroup(id),
      updateSchema: UpdateUserGroupSchema,
      updateFn: (id, data, actor) => svc.updateUserGroup(id, data, actor),
      deleteFn: (id, actor) => svc.deleteUserGroup(id, actor),
      notFoundCode: 'USERGROUP_NOT_FOUND',
      notFoundMsg: 'User group not found',
    }));
    app.route('/user-groups', userGroups);
    app.route('/user-groups/', userGroups);
  }

  // ─── Permission groups CRUD ───
  {
    const permGroups = new OpenAPIHono();

    registerCrudRoutes(permGroups, subCrud({
      guard: requireRoot,
      createSchema: CreatePermGroupSchema,
      createFn: (data, actor) => svc.createPermGroup(data, actor),
      listUrlFilter: nameFilter,
      listFn: (page, limit, filter) => svc.listPermGroupsPaginated(page, limit, filter),
      getFn: (id) => svc.getPermGroup(id),
      updateSchema: UpdatePermGroupSchema,
      updateFn: (id, data, actor) => svc.updatePermGroup(id, data, actor),
      deleteFn: (id, actor) => svc.deletePermGroup(id, actor),
      notFoundCode: 'PERMGROUP_NOT_FOUND',
      notFoundMsg: 'Permission group not found',
    }));

    // Extra route: create from template
    permGroups.post('/from-template/:templateId', async (c) => {
      requireRoot(c);
      const body = await z.unknown().parse(c.req.json());
      const templateData = CreatePermGroupSchema.partial().parse(body);
      const group = await svc.createPermGroupFromTemplate(c.req.param('templateId'), {
        name: templateData.name ?? c.req.param('templateId'),
        description: templateData.description,
        userGroupIds: templateData.userGroupIds,
        userIds: templateData.userIds,
      }, actorFrom(c));
      return c.json(ok(group), 201);
    });

    app.route('/groups', permGroups);
    app.route('/groups/', permGroups);
  }

  // ─── Templates (read-only) ───
  // eslint-disable-next-line @typescript-eslint/require-await -- interface contract requires Promise<T>
  app.openapi(createRoute({ method: 'get', path: '/templates', tags: ['permission'], responses: { 200: { description: '', content: { 'application/json': { schema: OkResponse(z.array(TemplateSchema)) } } } } }), async (c) => {
    return c.json(ok(svc.listTemplates()));
  });

  // eslint-disable-next-line @typescript-eslint/require-await -- interface contract requires Promise<T>
  app.openapi(createRoute({ method: 'get', path: '/templates/:id', tags: ['permission'], responses: { 200: { description: '', content: { 'application/json': { schema: OkResponse(TemplateSchema) } } } } }), async (c) => {
    const tpl = svc.getTemplate(c.req.param('id'));
    if (!tpl) throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'Template not found');
    return c.json(ok(tpl));
  });

  // ─── UserTemplate CRUD ───
  {
    const userTemplates = new OpenAPIHono();
    registerCrudRoutes(userTemplates, subCrud({
      guard: requireRoot,
      createSchema: CreateUserTplSchema,
      createFn: (data, actor) => svc.createUserTpl(data, actor),
      listUrlFilter: nameFilter,
      listFn: (page, limit, filter) => svc.listUserTplsPaginated(page, limit, filter),
      getFn: (id) => svc.getUserTpl(id),
      updateSchema: UpdateUserTplSchema,
      updateFn: (id, data, actor) => svc.updateUserTpl(id, data, actor),
      deleteFn: (id, actor) => svc.deleteUserTpl(id, actor),
      notFoundCode: 'USERTPL_NOT_FOUND',
      notFoundMsg: 'User template not found',
    }));
    app.route('/user-templates', userTemplates);
    app.route('/user-templates/', userTemplates);
  }

  // ─── Route ACL CRUD ───
  {
    const routeAcls = new OpenAPIHono();
    registerCrudRoutes(routeAcls, subCrud({
      guard: requireRoot,
      createSchema: CreateRouteAclSchema,
      createFn: (data, actor) => svc.createRouteAcl(data, actor),
      listUrlFilter: queryFilter('q'),
      listFn: (page, limit, filter) => svc.listRouteAclsPaginated(page, limit, filter),
      getFn: (id) => svc.getRouteAcl(id),
      updateSchema: UpdateRouteAclSchema,
      updateFn: (id, data, actor) => svc.updateRouteAcl(id, data, actor),
      deleteFn: (id, actor) => svc.deleteRouteAcl(id, actor),
      notFoundCode: 'ROUTEACL_NOT_FOUND',
      notFoundMsg: 'Route ACL not found',
    }));
    app.route('/route-acls', routeAcls);
    app.route('/route-acls/', routeAcls);
  }

  // ─── Invitations ───
  app.openapi(createRoute({ method: 'post', path: '/invite', tags: ['permission'], responses: { 201: { description: '', content: { 'application/json': { schema: OkResponse(InvitationSchema) } } } } }), async (c) => {
    const body = await z.unknown().parse(c.req.json());
    const inviteData = CreateInviteSchema.parse(body);
    const user = c.var.currentUser;
    if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    const invite = await svc.sendInvite(inviteData, user.id);
    return c.json(ok(invite), 201);
  });

  app.openapi(createRoute({ method: 'get', path: '/invitations', tags: ['permission'], responses: { 200: { description: '', content: { 'application/json': { schema: OkResponse(z.array(InvitationSchema)) } } } } }), async (c) => {
    const user = c.var.currentUser;
    if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    const invites = await svc.listInvitations(user.id);
    return c.json(ok(invites));
  });

  app.openapi(createRoute({ method: 'post', path: '/invitations/:id/accept', tags: ['permission'], responses: { 201: { description: '', content: { 'application/json': { schema: OkResponse(z.null()) } } } } }), async (c) => {
    const user = c.var.currentUser;
    if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    await svc.acceptInvite(c.req.param('id'), user.id);
    return c.json(ok(null));
  });

  app.openapi(createRoute({ method: 'post', path: '/invitations/:id/reject', tags: ['permission'], responses: { 201: { description: '', content: { 'application/json': { schema: OkResponse(z.null()) } } } } }), async (c) => {
    const user = c.var.currentUser;
    if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    await svc.rejectInvite(c.req.param('id'), user.id);
    return c.json(ok(null));
  });

  // ─── Log policy ───
  app.openapi(createRoute({ method: 'get', path: '/log-policy', tags: ['permission'], responses: { 200: { description: '', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    return c.json(ok(await svc.getLogPolicy()));
  });

  app.openapi(createRoute({ method: 'put', path: '/log-policy', tags: ['permission'], responses: { 200: { description: '', content: { 'application/json': { schema: OkResponse(z.unknown()) } } } } }), async (c) => {
    requireRoot(c);
    const body = UpdateLogPolicySchema.parse(await c.req.json());
    const policy = await svc.updateLogPolicy(z.custom<Partial<LogPolicy>>().parse(body), actorFrom(c));
    return c.json(ok(policy));
  });

  // ─── Capability management ───
  app.openapi(createRoute({ method: 'put', path: '/caps/user/:userId', tags: ['permission'], responses: { 200: { description: '', content: { 'application/json': { schema: OkResponse(UserCapsSchema) } } } } }), async (c) => {
    requireRoot(c);
    const raw = await c.req.json();
    const caps = z.number().parse(z.object({ caps: z.unknown() }).parse(raw).caps);
    await svc.setUserCaps(c.req.param('userId'), caps, actorFrom(c));
    return c.json(ok({ userId: c.req.param('userId'), caps }));
  });

  app.openapi(createRoute({ method: 'get', path: '/caps/user/:userId', tags: ['permission'], responses: { 200: { description: '', content: { 'application/json': { schema: OkResponse(UserCapsResultSchema) } } } } }), async (c) => {
    const result = await svc.getUserCaps(c.req.param('userId'));
    return c.json(ok(result));
  });

  app.openapi(createRoute({ method: 'put', path: '/caps/group/:groupId', tags: ['permission'], responses: { 200: { description: '', content: { 'application/json': { schema: OkResponse(GroupCapsSchema) } } } } }), async (c) => {
    requireRoot(c);
    const raw = await c.req.json();
    const caps = z.number().parse(z.object({ caps: z.unknown() }).parse(raw).caps);
    await svc.setGroupCaps(c.req.param('groupId'), caps, actorFrom(c));
    return c.json(ok({ groupId: c.req.param('groupId'), caps }));
  });

  app.openapi(createRoute({ method: 'get', path: '/caps/group/:groupId', tags: ['permission'], responses: { 200: { description: '', content: { 'application/json': { schema: OkResponse(GroupCapsResultSchema) } } } } }), async (c) => {
    const result = await svc.getGroupCaps(c.req.param('groupId'));
    return c.json(ok(result));
  });

  // ─── Temporary elevation (sudo) ───
  app.openapi(createRoute({ method: 'post', path: '/elevate', tags: ['permission'], responses: { 201: { description: '', content: { 'application/json': { schema: OkResponse(ElevationGrantSchema) } } } } }), async (c) => {
    requireRoot(c);
    const { userId, durationMs, capabilities } = await z.object({
      userId: z.string(),
      durationMs: z.number().optional(),
      capabilities: z.number().optional(),
    }).parse(c.req.json());
    const expiry = await svc.grantTempElevation(userId, durationMs, capabilities);
    return c.json(ok({ userId, expiry, capabilities }), 201);
  });

  app.openapi(createRoute({ method: 'delete', path: '/elevate/:userId', tags: ['permission'], responses: { 200: { description: '', content: { 'application/json': { schema: OkResponse(z.object({ revoked: z.boolean() })) } } } } }), async (c) => {
    requireRoot(c);
    await svc.revokeTempElevation(c.req.param('userId'));
    return c.json(ok({ revoked: true }));
  });

  app.openapi(createRoute({ method: 'get', path: '/elevations', tags: ['permission'], responses: { 200: { description: '', content: { 'application/json': { schema: OkResponse(z.array(ElevationEntrySchema)) } } } } }), async (c) => {
    const list = await svc.listTempElevations();
    return c.json(ok(list));
  });

  // ─── Compare ───
  app.openapi(createRoute({ method: 'post', path: '/compare/perm-groups', tags: ['permission'], responses: { 201: { description: '', content: { 'application/json': { schema: OkResponse(CompareResultSchema) } } } } }), async (c) => {
    requireRoot(c);
    const { idA, idB } = z.object({ idA: z.string(), idB: z.string() }).parse(await c.req.json());
    return c.json(ok(await svc.comparePermGroups(idA, idB)), 201);
  });

  app.openapi(createRoute({ method: 'post', path: '/compare/user-groups', tags: ['permission'], responses: { 201: { description: '', content: { 'application/json': { schema: OkResponse(CompareResultSchema) } } } } }), async (c) => {
    requireRoot(c);
    const { idA, idB } = z.object({ idA: z.string(), idB: z.string() }).parse(await c.req.json());
    return c.json(ok(await svc.compareUserGroups(idA, idB)), 201);
  });

  // ─── Permission check ───
  app.openapi(createRoute({ method: 'post', path: '/check', tags: ['permission'], responses: { 201: { description: '', content: { 'application/json': { schema: OkResponse(PolicyMatchResultSchema) } } } } }), async (c) => {
    requireRoot(c);
    const body = await z.unknown().parse(c.req.json());
    const checkData = PermissionCheckSchema.parse(body);
    return c.json(ok(await svc.check(checkData)));
  });

  return app;
}