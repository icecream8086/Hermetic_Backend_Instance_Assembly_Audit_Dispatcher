import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../../core/deps.ts';
import type { IPermissionService } from './service.ts';
import type { RouteMeta } from '../../core/http-docs/types.ts';
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
import type { ErrorCode } from '../../core/error-codes.ts';
import type { AuditActor } from './audit.ts';
import { z, type ZodType } from 'zod';
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

function actorFrom(c: any): AuditActor | undefined {
  const u = c.var?.currentUser;
  if (!u) return undefined;
  return { userId: u.id, ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() };
}

function requireRoot(c: Context<{ Variables: AppContext }>): Response | null {
  const user = c.var?.currentUser;
  if (!user) return null;
  const isRoot = user.role === 'root' || user.role === 'Operator' || user.role === 'wheel';
  if (!isRoot) return c.json(fail('FORBIDDEN', 'Admin access required'), 403);
  return null;
}

function requireWheel(c: any): Response | null {
  const user = c.var?.currentUser;
  if (!user) return null;
  if (user.role !== 'wheel') return c.json(fail('FORBIDDEN', 'Wheel privilege required'), 403);
  return null;
}

// ─── CRUD sub-resource factory ───

interface SubCrudOpts<T> {
  guard: (c: any) => Response | null;
  createSchema: ZodType;
  createFn: (data: any, actor: AuditActor | undefined) => Promise<T>;
  listUrlFilter: (c: any) => ((item: any) => boolean) | undefined;
  listFn: (page: number, limit: number, filter: ((item: any) => boolean) | undefined) => Promise<PaginatedResult<T>>;
  getFn: (id: string) => Promise<T | null>;
  updateSchema: ZodType;
  updateFn: (id: string, data: any, actor: AuditActor | undefined) => Promise<T>;
  deleteFn: (id: string, actor: AuditActor | undefined) => Promise<void>;
  notFoundCode: ErrorCode;
  notFoundMsg: string;
}

/** Build a CrudHandlerMap for a sub-resource. TypeScript enforces all 5 actions are present. */
function subCrud<T>(opts: SubCrudOpts<T>): CrudHandlerMap {
  return {
    create: (r) => r.post('/', async (c) => {
      { const rv = opts.guard(c); if (rv) return rv; }
      const body: unknown = await c.req.json();
      const parsed = opts.createSchema.safeParse(body);
      if (!parsed.success) return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
      const result = await opts.createFn(parsed.data, actorFrom(c));
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
      { const rv = opts.guard(c); if (rv) return rv; }
      const body: unknown = await c.req.json();
      const parsed = opts.updateSchema.safeParse(body);
      if (!parsed.success) return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
      return c.json(ok(await opts.updateFn(c.req.param('id'), parsed.data, actorFrom(c))));
    }),

    delete: (r) => r.delete('/:id', async (c) => {
      { const rv = opts.guard(c); if (rv) return rv; }
      await opts.deleteFn(c.req.param('id'), actorFrom(c));
      return c.json(ok(null));
    }),
  };
}

// ─── Name-based filter helper ───

function nameFilter(c: any): ((item: any) => boolean) | undefined {
  const name = c.req.query('name');
  return name ? (item: any) => item.name?.toLowerCase().includes(name.toLowerCase()) : undefined;
}

function queryFilter(key: string) {
  return (c: any): ((item: any) => boolean) | undefined => {
    const q = c.req.query(key);
    return q ? (item: any) => (item.pathPrefix ?? '').toLowerCase().includes(q.toLowerCase()) || (item.method ?? '').toLowerCase().includes(q.toLowerCase()) : undefined;
  };
}

// ═══════════════════════════════════════════════════════════════
// Main router
// ═══════════════════════════════════════════════════════════════

export function createPermissionRouter(svc: IPermissionService): Hono<{ Variables: AppContext }> {
  const router = new Hono<{ Variables: AppContext }>();

  // ─── Policies CRUD ───
  {
    const policies = new Hono<any>();
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
    router.route('/policies', policies);
    router.route('/policies/', policies);
  }

  // ─── User groups CRUD ───
  {
    const userGroups = new Hono<any>();
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
    router.route('/user-groups', userGroups);
    router.route('/user-groups/', userGroups);
  }

  // ─── Permission groups CRUD ───
  {
    const permGroups = new Hono<any>();

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
      { const r = requireRoot(c); if (r) return r; }
      const body: unknown = await c.req.json();
      const parsed = CreatePermGroupSchema.partial().safeParse(body);
      if (!parsed.success) return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
      const group = await svc.createPermGroupFromTemplate(c.req.param('templateId'), {
        name: parsed.data.name ?? c.req.param('templateId'),
        description: parsed.data.description,
        userGroupIds: parsed.data.userGroupIds,
        userIds: parsed.data.userIds,
      }, actorFrom(c));
      return c.json(ok(group), 201);
    });

    router.route('/groups', permGroups);
    router.route('/groups/', permGroups);
  }

  // ─── Templates (read-only) ───
  router.get('/templates', async (c) => {
    return c.json(ok(svc.listTemplates()));
  });

  router.get('/templates/:id', async (c) => {
    const tpl = svc.getTemplate(c.req.param('id'));
    if (!tpl) return c.json(fail('TEMPLATE_NOT_FOUND', 'Template not found'), 404);
    return c.json(ok(tpl));
  });

  // ─── UserTemplate CRUD ───
  {
    const userTemplates = new Hono<any>();
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
    router.route('/user-templates', userTemplates);
    router.route('/user-templates/', userTemplates);
  }

  // ─── Route ACL CRUD ───
  {
    const routeAcls = new Hono<any>();
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
    router.route('/route-acls', routeAcls);
    router.route('/route-acls/', routeAcls);
  }

  // ─── Invitations ───
  router.post('/invite', async (c) => {
    const body: unknown = await c.req.json();
    const parsed = CreateInviteSchema.safeParse(body);
    if (!parsed.success) return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    const user = c.var?.currentUser;
    if (!user) return c.json(fail('UNAUTHORIZED', 'Authentication required'), 401);
    const invite = await svc.sendInvite(parsed.data, user.id);
    return c.json(ok(invite), 201);
  });

  router.get('/invitations', async (c) => {
    const user = c.var?.currentUser;
    if (!user) return c.json(fail('UNAUTHORIZED', 'Authentication required'), 401);
    const invites = await svc.listInvitations(user.id);
    return c.json(ok(invites));
  });

  router.post('/invitations/:id/accept', async (c) => {
    const user = c.var?.currentUser;
    if (!user) return c.json(fail('UNAUTHORIZED', 'Authentication required'), 401);
    await svc.acceptInvite(c.req.param('id'), user.id);
    return c.json(ok(null));
  });

  router.post('/invitations/:id/reject', async (c) => {
    const user = c.var?.currentUser;
    if (!user) return c.json(fail('UNAUTHORIZED', 'Authentication required'), 401);
    await svc.rejectInvite(c.req.param('id'), user.id);
    return c.json(ok(null));
  });

  // ─── Log policy ───
  router.get('/log-policy', async (c) => {
    return c.json(ok(await svc.getLogPolicy()));
  });

  router.put('/log-policy', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    const body: unknown = await c.req.json();
    const parsed = UpdateLogPolicySchema.safeParse(body);
    if (!parsed.success) return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    const policy = await svc.updateLogPolicy(parsed.data as any, actorFrom(c));
    return c.json(ok(policy));
  });

  // ─── Capability management ───
  router.put('/caps/user/:userId', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    const { caps } = await c.req.json<{ caps: number }>();
    if (typeof caps !== 'number') return c.json(fail('VALIDATION_ERROR', 'caps must be a number (bitmask)'), 400);
    await svc.setUserCaps(c.req.param('userId'), caps, actorFrom(c));
    return c.json(ok({ userId: c.req.param('userId'), caps }));
  });

  router.get('/caps/user/:userId', async (c) => {
    const result = await svc.getUserCaps(c.req.param('userId'));
    return c.json(ok(result));
  });

  router.put('/caps/group/:groupId', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    const { caps } = await c.req.json<{ caps: number }>();
    if (typeof caps !== 'number') return c.json(fail('VALIDATION_ERROR', 'caps must be a number (bitmask)'), 400);
    await svc.setGroupCaps(c.req.param('groupId'), caps, actorFrom(c));
    return c.json(ok({ groupId: c.req.param('groupId'), caps }));
  });

  router.get('/caps/group/:groupId', async (c) => {
    const result = await svc.getGroupCaps(c.req.param('groupId'));
    return c.json(ok(result));
  });

  // ─── Temporary elevation (sudo) ───
  router.post('/elevate', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    const { userId, durationMs, capabilities } = await c.req.json<{ userId: string; durationMs?: number; capabilities?: number }>();
    if (!userId) return c.json(fail('VALIDATION_ERROR', 'userId required'), 400);
    const expiry = await svc.grantTempElevation(userId, durationMs, capabilities);
    return c.json(ok({ userId, expiry, capabilities }));
  });

  router.delete('/elevate/:userId', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    await svc.revokeTempElevation(c.req.param('userId'));
    return c.json(ok({ revoked: true }));
  });

  router.get('/elevations', async (c) => {
    const list = await svc.listTempElevations();
    return c.json(ok(list));
  });

  // ─── Compare ───
  router.post('/compare/perm-groups', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    const { idA, idB } = await c.req.json<{ idA: string; idB: string }>();
    if (!idA || !idB) return c.json(fail('VALIDATION_ERROR', 'idA and idB required'), 400);
    try { return c.json(ok(await svc.comparePermGroups(idA, idB))); }
    catch (e: any) { return c.json(fail('NOT_FOUND', e.message), 404); }
  });

  router.post('/compare/user-groups', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    const { idA, idB } = await c.req.json<{ idA: string; idB: string }>();
    if (!idA || !idB) return c.json(fail('VALIDATION_ERROR', 'idA and idB required'), 400);
    try { return c.json(ok(await svc.compareUserGroups(idA, idB))); }
    catch (e: any) { return c.json(fail('NOT_FOUND', e.message), 404); }
  });

  // ─── Permission check ───
  router.post('/check', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    const body: unknown = await c.req.json();
    const parsed = PermissionCheckSchema.safeParse(body);
    if (!parsed.success) return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    return c.json(ok(await svc.check(parsed.data)));
  });

  return router;
}

export const permissionRouteMeta: RouteMeta[] = [
  // ─── Individual policies ───
  { method: 'POST', path: '/policies', description: '创建权限策略 — 定义一条 (who, action, resource) 的 allow/deny 规则，可绑定到 userId 或 role', requestBody: { name: 'Allow login', effect: 'allow', actions: ['login'], resource: 'session' }, responseDescription: 'StoredPolicy' },
  { method: 'GET', path: '/policies', description: '列出所有权限策略', responseDescription: 'StoredPolicy[]' },
  { method: 'GET', path: '/policies/:id', description: '按 ID 获取策略详情', responseDescription: 'StoredPolicy' },
  { method: 'PUT', path: '/policies/:id', description: '更新策略（name/effect/actions/priority/enabled）', requestBody: { name: 'Updated', priority: 10 }, responseDescription: 'StoredPolicy' },
  { method: 'DELETE', path: '/policies/:id', description: '删除策略', responseDescription: '{ ok: true }' },

  // ─── User groups ───
  { method: 'POST', path: '/user-groups', description: '创建用户组 — 组内用户共享权限。dependsOn 支持 DAG 继承父组', requestBody: { name: 'Admins', memberIds: ['uuid-1', 'uuid-2'] }, responseDescription: 'UserGroup' },
  { method: 'GET', path: '/user-groups', description: '列出所有用户组', responseDescription: 'UserGroup[]' },
  { method: 'GET', path: '/user-groups/:id', description: '按 ID 获取用户组（含成员列表）', responseDescription: 'UserGroup' },
  { method: 'PUT', path: '/user-groups/:id', description: '更新用户组（名称/成员/dependsOn 依赖）', requestBody: { name: 'Super Admins', memberIds: ['uuid-1'] }, responseDescription: 'UserGroup' },
  { method: 'DELETE', path: '/user-groups/:id', description: '删除用户组', responseDescription: '{ ok: true }' },

  // ─── Permission groups ───
  { method: 'POST', path: '/groups', description: '创建权限组 — 一组规则集合，可绑定到用户组或用户。dependsOn 继承父组规则', requestBody: { name: 'Operators', rules: [{ effect: 'allow', actions: ['read'], priority: 10 }] }, responseDescription: 'PermissionGroup' },
  { method: 'POST', path: '/groups/from-template/:templateId', description: '从模板创建权限组 — 内置模板: admin(完全), operator(CRUD), viewer(只读), login-only(仅登录)', requestBody: { name: 'My Admins', userGroupIds: ['usergrp_xxx'] }, responseDescription: 'PermissionGroup' },
  { method: 'GET', path: '/groups', description: '列出所有权限组', responseDescription: 'PermissionGroup[]' },
  { method: 'GET', path: '/groups/:id', description: '按 ID 获取权限组（含规则和绑定列表）', responseDescription: 'PermissionGroup' },
  { method: 'PUT', path: '/groups/:id', description: '更新权限组（名称/规则/dependsOn/绑定的用户或组）', requestBody: { rules: [{ effect: 'deny', actions: ['delete'], priority: 99 }] }, responseDescription: 'PermissionGroup' },
  { method: 'DELETE', path: '/groups/:id', description: '删除权限组', responseDescription: '{ ok: true }' },

  // ─── Permission templates ───
  { method: 'GET', path: '/templates', description: '列出内置权限模板（admin / operator / viewer / login-only）', responseDescription: 'Template[]' },
  { method: 'GET', path: '/templates/:id', description: '按 ID 获取内置模板详情', responseDescription: 'Template' },

  // ─── User templates ───
  { method: 'POST', path: '/user-templates', description: '创建用户模板 — 预设新用户注册时自动加入哪些组。dependsOn 支持模板继承', requestBody: { name: 'developer', defaultGroupIds: ['usergrp_uuid'], dependsOn: ['usertpl_uuid'] }, responseDescription: 'UserTemplate' },
  { method: 'GET', path: '/user-templates', description: '列出所有用户模板', responseDescription: 'UserTemplate[]' },
  { method: 'GET', path: '/user-templates/:id', description: '按 ID 获取用户模板', responseDescription: 'UserTemplate' },
  { method: 'PUT', path: '/user-templates/:id', description: '更新用户模板', requestBody: { defaultGroupIds: [] }, responseDescription: 'UserTemplate' },
  { method: 'DELETE', path: '/user-templates/:id', description: '删除用户模板', responseDescription: '{ ok: true }' },

  // ─── Route ACLs ───
  { method: 'POST', path: '/route-acls', description: '创建路由绑定 — 定义 (method + path) 谁可以访问。绑定到 userId 或 userGroupId', requestBody: { method: 'GET', pathPrefix: '/api/users', matchType: 'prefix', effect: 'allow', userId: 'uuid', priority: 100 }, responseDescription: 'RouteAcl' },
  { method: 'GET', path: '/route-acls', description: '列出所有路由绑定', responseDescription: 'RouteAcl[]' },
  { method: 'GET', path: '/route-acls/:id', description: '按 ID 获取路由绑定', responseDescription: 'RouteAcl' },
  { method: 'PUT', path: '/route-acls/:id', description: '更新路由绑定 — 可改 method/matchType/effect/priority', requestBody: { matchType: 'exact', effect: 'deny', priority: 99 }, responseDescription: 'RouteAcl' },
  { method: 'DELETE', path: '/route-acls/:id', description: '删除路由绑定', responseDescription: '{ ok: true }' },

  // ─── Compare ───
  { method: 'GET', path: '/log-policy', description: '获取全局日志策略配置（默认值 + 各 facility 级别）。无策略时返回内置默认值', responseDescription: 'LogPolicy' },
  { method: 'PUT', path: '/log-policy', description: '更新全局日志策略 — 调整 defaultLevel/auditLevel/facilities[]。仅 wheel 组可操作', requestBody: { defaultLevel: 'info', facilities: [{ facility: 'user-service', level: 'debug' }] }, responseDescription: 'LogPolicy' },
  { method: 'POST', path: '/compare/perm-groups', description: '对比两个权限组 — 选取两个权限组 id，返回规则差异(common/onlyA/onlyB) 和 DAG 依赖链差异(depDiff)', requestBody: { idA: 'permgrp_uuid1', idB: 'permgrp_uuid2' }, responseDescription: 'CompareResult' },
  { method: 'POST', path: '/compare/user-groups', description: '对比两个用户组 — 选取两个用户组 id，返回成员差异(common/onlyA/onlyB) 和 DAG 依赖链差异(depDiff)', requestBody: { idA: 'usergrp_uuid1', idB: 'usergrp_uuid2' }, responseDescription: 'CompareResult' },

  // ─── Check ───
  { method: 'POST', path: '/check', description: '权限检查 — 模拟某用户对某资源的访问权限。评估 loginPolicy + 个人策略 + 权限组规则 + DAG 继承链', requestBody: { userId: 'uuid', action: 'login', resource: 'session', ip: '10.0.0.1' }, responseDescription: 'PolicyMatchResult' },
];
