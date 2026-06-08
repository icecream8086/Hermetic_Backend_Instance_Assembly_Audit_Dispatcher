import { Hono } from 'hono';
import type { AppContext } from '../../core/app.ts';
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
import type { AuditActor } from './audit.ts';
import { z } from 'zod';

const LogLevelEnum = z.enum(['debug', 'info', 'warn', 'warning', 'error', 'none', 'notice', 'fatal']);

const KNOWN_FACILITIES = [
  'user-service', 'perm', 'perm-audit', 'authz', 'sysgrp',
  'sandbox-service', 'template', 'dns-service', 'quota', 'http',
  'subnet', 'secgroup', 'system',
] as const;

const UpdateLogPolicySchema = z.object({
  defaultLevel: LogLevelEnum.optional(),
  auditLevel: LogLevelEnum.optional(),
  facilities: z.array(z.object({
    facility: z.enum(KNOWN_FACILITIES),
    level: LogLevelEnum,
  })).optional(),
});

function actorFrom(c: any): AuditActor | undefined {
  const u = c.var?.currentUser;
  if (!u) return undefined;
  return { userId: u.id, ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() };
}

/** Reject non-root users on admin endpoints. No-op when authz is disabled (no currentUser). */
function requireRoot(c: any): Response | null {
  const user = c.var?.currentUser;
  if (!user) return null; // authz disabled — allow
  const isRoot = user.role === 'root' || user.role === 'Operator' || user.role === 'wheel';
  if (!isRoot) {
    return c.json(fail('FORBIDDEN', 'Admin access required'), 403);
  }
  return null;
}

/**
 * Reject non-wheel users. Only users with role 'wheel' have full access to ALL groups.
 * root/Operator can only manage groups where they're explicitly listed as admin.
 */
function requireWheel(c: any): Response | null {
  const user = c.var?.currentUser;
  if (!user) return null; // authz disabled
  if (user.role !== 'wheel') {
    return c.json(fail('FORBIDDEN', 'Wheel privilege required'), 403);
  }
  return null;
}

export function createPermissionRouter(svc: IPermissionService): Hono<{ Variables: AppContext }> {
  const router = new Hono<{ Variables: AppContext }>();

  // ═══════════════════════════════════
  // Individual policies CRUD
  // ═══════════════════════════════════

  router.post('/policies', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    const body: unknown = await c.req.json();
    const parsed = CreatePolicySchema.safeParse(body);
    if (!parsed.success) return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    const policy = await svc.createPolicy(parsed.data, actorFrom(c));
    return c.json(ok(policy), 201);
  });

  router.get('/policies', async (c) => {
    const page = parseInt(c.req.query('page') ?? '') || 1;
    const limit = parseInt(c.req.query('limit') ?? '') || 50;
    const name = c.req.query('name');
    const filter = name ? (item: any) => item.name?.toLowerCase().includes(name.toLowerCase()) : undefined;
    return c.json(ok(await svc.listPoliciesPaginated(page, limit, filter)));
  });

  router.get('/policies/:id', async (c) => {
    const policy = await svc.getPolicy(c.req.param('id'));
    if (!policy) return c.json(fail('POLICY_NOT_FOUND', 'Policy not found'), 404);
    return c.json(ok(policy));
  });

  router.put('/policies/:id', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    const body: unknown = await c.req.json();
    const parsed = UpdatePolicySchema.safeParse(body);
    if (!parsed.success) return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    return c.json(ok(await svc.updatePolicy(c.req.param('id'), parsed.data, actorFrom(c))));
  });

  router.delete('/policies/:id', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    await svc.deletePolicy(c.req.param('id'), actorFrom(c));
    return c.json(ok(null));
  });

  // ═══════════════════════════════════
  // User groups CRUD
  // ═══════════════════════════════════

  router.post('/user-groups', async (c) => {
    { const r = requireWheel(c); if (r) return r; }
    const body: unknown = await c.req.json();
    const parsed = CreateUserGroupSchema.safeParse(body);
    if (!parsed.success) return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    const group = await svc.createUserGroup(parsed.data, actorFrom(c));
    return c.json(ok(group), 201);
  });

  router.get('/user-groups', async (c) => {
    const page = parseInt(c.req.query('page') ?? '') || 1;
    const limit = parseInt(c.req.query('limit') ?? '') || 50;
    const name = c.req.query('name');
    const filter = name ? (item: any) => item.name?.toLowerCase().includes(name.toLowerCase()) : undefined;
    return c.json(ok(await svc.listUserGroupsPaginated(page, limit, filter)));
  });

  router.get('/user-groups/:id', async (c) => {
    const group = await svc.getUserGroup(c.req.param('id'));
    if (!group) return c.json(fail('USERGROUP_NOT_FOUND', 'User group not found'), 404);
    return c.json(ok(group));
  });

  router.put('/user-groups/:id', async (c) => {
    { const r = requireWheel(c); if (r) return r; }
    const body: unknown = await c.req.json();
    const parsed = UpdateUserGroupSchema.safeParse(body);
    if (!parsed.success) return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    return c.json(ok(await svc.updateUserGroup(c.req.param('id'), parsed.data, actorFrom(c))));
  });

  router.delete('/user-groups/:id', async (c) => {
    { const r = requireWheel(c); if (r) return r; }
    await svc.deleteUserGroup(c.req.param('id'), actorFrom(c));
    return c.json(ok(null));
  });

  // ═══════════════════════════════════
  // Permission groups CRUD
  // ═══════════════════════════════════

  router.post('/groups', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    const body: unknown = await c.req.json();
    const parsed = CreatePermGroupSchema.safeParse(body);
    if (!parsed.success) return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    const group = await svc.createPermGroup(parsed.data, actorFrom(c));
    return c.json(ok(group), 201);
  });

  router.post('/groups/from-template/:templateId', async (c) => {
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

  router.get('/groups', async (c) => {
    const page = parseInt(c.req.query('page') ?? '') || 1;
    const limit = parseInt(c.req.query('limit') ?? '') || 50;
    const name = c.req.query('name');
    const filter = name ? (item: any) => item.name?.toLowerCase().includes(name.toLowerCase()) : undefined;
    return c.json(ok(await svc.listPermGroupsPaginated(page, limit, filter)));
  });

  router.get('/groups/:id', async (c) => {
    const group = await svc.getPermGroup(c.req.param('id'));
    if (!group) return c.json(fail('PERMGROUP_NOT_FOUND', 'Permission group not found'), 404);
    return c.json(ok(group));
  });

  router.put('/groups/:id', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    const body: unknown = await c.req.json();
    const parsed = UpdatePermGroupSchema.safeParse(body);
    if (!parsed.success) return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    return c.json(ok(await svc.updatePermGroup(c.req.param('id'), parsed.data, actorFrom(c))));
  });

  router.delete('/groups/:id', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    await svc.deletePermGroup(c.req.param('id'), actorFrom(c));
    return c.json(ok(null));
  });

  // ═══════════════════════════════════
  // Templates (read-only)
  // ═══════════════════════════════════

  router.get('/templates', async (c) => {
    return c.json(ok(svc.listTemplates()));
  });

  router.get('/templates/:id', async (c) => {
    const tpl = svc.getTemplate(c.req.param('id'));
    if (!tpl) return c.json(fail('TEMPLATE_NOT_FOUND', 'Template not found'), 404);
    return c.json(ok(tpl));
  });

  // ═══════════════════════════════════
  // UserTemplate CRUD
  // ═══════════════════════════════════

  router.post('/user-templates', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    const body: unknown = await c.req.json();
    const parsed = CreateUserTplSchema.safeParse(body);
    if (!parsed.success) return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    const tpl = await svc.createUserTpl(parsed.data, actorFrom(c));
    return c.json(ok(tpl), 201);
  });

  router.get('/user-templates', async (c) => {
    const page = parseInt(c.req.query('page') ?? '') || 1;
    const limit = parseInt(c.req.query('limit') ?? '') || 50;
    const name = c.req.query('name');
    const filter = name ? (item: any) => item.name?.toLowerCase().includes(name.toLowerCase()) : undefined;
    return c.json(ok(await svc.listUserTplsPaginated(page, limit, filter)));
  });

  router.get('/user-templates/:id', async (c) => {
    const tpl = await svc.getUserTpl(c.req.param('id'));
    if (!tpl) return c.json(fail('USERTPL_NOT_FOUND', 'User template not found'), 404);
    return c.json(ok(tpl));
  });

  router.put('/user-templates/:id', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    const body: unknown = await c.req.json();
    const parsed = UpdateUserTplSchema.safeParse(body);
    if (!parsed.success) return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    return c.json(ok(await svc.updateUserTpl(c.req.param('id'), parsed.data, actorFrom(c))));
  });

  router.delete('/user-templates/:id', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    await svc.deleteUserTpl(c.req.param('id'), actorFrom(c));
    return c.json(ok(null));
  });

  // ═══════════════════════════════════
  // Route ACL CRUD
  // ═══════════════════════════════════

  router.post('/route-acls', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    const body: unknown = await c.req.json();
    const parsed = CreateRouteAclSchema.safeParse(body);
    if (!parsed.success) return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    const acl = await svc.createRouteAcl(parsed.data, actorFrom(c));
    return c.json(ok(acl), 201);
  });

  router.get('/route-acls', async (c) => {
    const page = parseInt(c.req.query('page') ?? '') || 1;
    const limit = parseInt(c.req.query('limit') ?? '') || 50;
    const q = c.req.query('q'); // search by pathPrefix or method
    const filter = q ? (item: any) => (item.pathPrefix ?? '').toLowerCase().includes(q.toLowerCase()) || (item.method ?? '').toLowerCase().includes(q.toLowerCase()) : undefined;
    return c.json(ok(await svc.listRouteAclsPaginated(page, limit, filter)));
  });

  router.get('/route-acls/:id', async (c) => {
    const acl = await svc.getRouteAcl(c.req.param('id'));
    if (!acl) return c.json(fail('ROUTEACL_NOT_FOUND', 'Route ACL not found'), 404);
    return c.json(ok(acl));
  });

  router.put('/route-acls/:id', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    const body: unknown = await c.req.json();
    const parsed = UpdateRouteAclSchema.safeParse(body);
    if (!parsed.success) return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    return c.json(ok(await svc.updateRouteAcl(c.req.param('id'), parsed.data, actorFrom(c))));
  });

  router.delete('/route-acls/:id', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    await svc.deleteRouteAcl(c.req.param('id'), actorFrom(c));
    return c.json(ok(null));
  });

  // ═══════════════════════════════════
  // Invitations
  // ═══════════════════════════════════

  // POST /invite — send invitation (requires admin of the group)
  router.post('/invite', async (c) => {
    const body: unknown = await c.req.json();
    const parsed = CreateInviteSchema.safeParse(body);
    if (!parsed.success) return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    const user = c.var?.currentUser;
    if (!user) return c.json(fail('UNAUTHORIZED', 'Authentication required'), 401);
    const invite = await svc.sendInvite(parsed.data, user.id);
    return c.json(ok(invite), 201);
  });

  // GET /invitations — list current user's pending invitations
  router.get('/invitations', async (c) => {
    const user = c.var?.currentUser;
    if (!user) return c.json(fail('UNAUTHORIZED', 'Authentication required'), 401);
    const invites = await svc.listInvitations(user.id);
    return c.json(ok(invites));
  });

  // POST /invitations/:id/accept — accept invitation
  router.post('/invitations/:id/accept', async (c) => {
    const user = c.var?.currentUser;
    if (!user) return c.json(fail('UNAUTHORIZED', 'Authentication required'), 401);
    await svc.acceptInvite(c.req.param('id'), user.id);
    return c.json(ok(null));
  });

  // POST /invitations/:id/reject — reject invitation
  router.post('/invitations/:id/reject', async (c) => {
    const user = c.var?.currentUser;
    if (!user) return c.json(fail('UNAUTHORIZED', 'Authentication required'), 401);
    await svc.rejectInvite(c.req.param('id'), user.id);
    return c.json(ok(null));
  });

  // ═══════════════════════════════════
  // Log policy (wheel-only via auth middleware)
  // ═══════════════════════════════════

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

  // ═══════════════════════════════════
  // Compare
  // ═══════════════════════════════════════

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

  // ═══════════════════════════════════
  // Permission check
  // ═══════════════════════════════════

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
