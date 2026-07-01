import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { z } from 'zod';
import { AppError } from '../../core/types.ts';
import type { AppContext } from '../../core/deps.ts';
import type { IUserService } from './service.ts';
import { RegisterUserSchema, LoginUserSchema, UpdateUserSchema, UserResponseSchema, LoginResponseSchema, LoginPolicySchema, NoPasswordLoginSchema, PublicKeySchema } from './schema.ts';
import type { UserResponse } from './schema.ts';
import { createUserId, createSessionToken, createGid, UserRole } from './types.ts';
import { ok } from '../../core/response.ts';
import { OkResponse, PaginatedResponse } from '../../core/http-docs/response-schema.ts';

// ─── Avatar constants ───
const AVATAR_MAX_SIZE = 1048576;
const AVATAR_META_PREFIX = 'avatar:meta:';
const AVATAR_BLOB_PREFIX = 'avatar:';
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function detectImageType(buf: Uint8Array): string | null {
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
    if (buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  return null;
}

function userToResponse(user: { id: string; email: string; name: string; role: UserRole; uid?: number; gid?: number; gecos?: string; directory?: string; shell?: string; supplementaryGids?: number[]; createdAt: number; updatedAt: number }): UserResponse {
  return UserResponseSchema.parse({
    id: user.id, email: user.email, name: user.name, role: user.role,
    uid: user.uid ?? 1000, gid: user.gid ?? 1000,
    gecos: user.gecos ?? user.name, directory: user.directory ?? `/home/${user.email}`,
    shell: user.shell ?? '/bin/bash', supplementaryGids: user.supplementaryGids ?? [],
    createdAt: user.createdAt, updatedAt: user.updatedAt,
  });
}

interface PermissionCheckFn { check(params: { userId: string; action: string; resource: string; ip?: string; resourceOwnerId?: string }): Promise<{ allowed: boolean; reason: string }> }
interface UsersEnv { Variables: AppContext }

async function requirePerm(c: Context<UsersEnv>, checker: PermissionCheckFn | undefined, action: string, resource: string, resourceOwnerId?: string): Promise<void> {
  if (!checker) return;
  const user = c.var.currentUser;
  if (!user) return;
  const result = await checker.check({ userId: user.id, action, resource, ...(resourceOwnerId ? { resourceOwnerId } : {}) });
  if (!result.allowed) throw new AppError(403, 'FORBIDDEN', result.reason);
}

export function createUserRouter(userService: IUserService, permissionChecker?: PermissionCheckFn): OpenAPIHono<{ Variables: AppContext }> {
  const app = new OpenAPIHono<{ Variables: AppContext }>();

  app.openapi(createRoute({ method: 'post', path: '/register', tags: ['users'], summary: '注册新用户', request: { body: { content: { 'application/json': { schema: RegisterUserSchema } } } }, responses: { 201: { description: 'LoginResponse', content: { 'application/json': { schema: OkResponse(LoginResponseSchema) } } } } }), async (c) => {
    const body = await RegisterUserSchema.parse(c.req.json());
    const atomic = c.var.stores.atomic;
    const initKey = '_sys:initialized';
    const initEntry = await atomic.get<boolean>(initKey);
    const isFirst = initEntry?.value !== true;
    let role = UserRole.Viewer;
    if (isFirst) {
      const claimed = await atomic.set(initKey, true, null);
      if (claimed) role = UserRole.Root;
    }
    const { user, token } = await userService.register({ email: body.email, password: body.password, name: body.name, role });
    return c.json(ok(LoginResponseSchema.parse({ token, user: userToResponse(user) })), 201);
  });

  app.openapi(createRoute({ method: 'post', path: '/login', tags: ['users'], summary: '用户登录', request: { body: { content: { 'application/json': { schema: LoginUserSchema } } } }, responses: { 200: { description: 'LoginResponse', content: { 'application/json': { schema: OkResponse(LoginResponseSchema) } } } } }), async (c) => {
    const body = await LoginUserSchema.parse(c.req.json());
    const loginIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('cf-connecting-ip');
    const { user, token } = await userService.login({ email: body.email, password: body.password }, { ip: loginIp, siteContext: undefined });
    return c.json(ok(LoginResponseSchema.parse({ token, user: userToResponse(user) })));
  });

  app.openapi(createRoute({ method: 'get', path: '/login-info', tags: ['users'], summary: '查询邮箱的登录方式', responses: { 200: { description: 'LoginInfo', content: { 'application/json': { schema: OkResponse(z.object({ exists: z.boolean(), methods: z.array(z.enum(['password', 'no-password'])), policy: z.object({ enabled: z.boolean(), disabled: z.boolean(), timeRestricted: z.boolean(), timeRanges: z.array(z.object({ start: z.string(), end: z.string() })) }).optional() })) } } } } }), async (c) => {
    const email = c.req.query('email');
    if (!email) throw new AppError(400, 'VALIDATION_ERROR', 'email query param required');
    const parsedEmail = z.email().parse(email);
    const info = await userService.getLoginInfo(parsedEmail);
    return c.json(ok(info));
  });

  app.openapi(createRoute({ method: 'get', path: '/{id}', tags: ['users'], summary: '获取用户', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'UserResponse', content: { 'application/json': { schema: OkResponse(UserResponseSchema) } } } } }), async (c) => {
    const id = createUserId(c.req.param('id'));
    const user = await userService.getById(id);
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    return c.json(ok(userToResponse(user)));
  });

  app.openapi(createRoute({ method: 'put', path: '/{id}', tags: ['users'], summary: '更新用户', request: { params: z.object({ id: z.string() }), body: { content: { 'application/json': { schema: UpdateUserSchema } } } }, responses: { 200: { description: 'UserResponse', content: { 'application/json': { schema: OkResponse(UserResponseSchema) } } } } }), async (c) => {
    const id = createUserId(c.req.param('id'));
    const body = await UpdateUserSchema.parse(c.req.json());
    await requirePerm(c, permissionChecker, 'update', 'user', id);
    const actorId = c.var.currentUser?.id;
    const user = await userService.update(id, {
      name: body.name, password: body.password, role: body.role, loginPolicy: body.loginPolicy,
      publicKeyEd25519: body.publicKeyEd25519, gecos: body.gecos, directory: body.directory,
      shell: body.shell, supplementaryGids: body.supplementaryGids,
    }, actorId);
    return c.json(ok(userToResponse(user)));
  });

  app.openapi(createRoute({ method: 'delete', path: '/{id}', tags: ['users'], summary: '删除用户', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: OkResponse(z.null()) } } } } }), async (c) => {
    const id = createUserId(c.req.param('id'));
    await requirePerm(c, permissionChecker, 'delete', 'user', id);
    await userService.delete(id, c.var.currentUser?.id);
    return c.json(ok(null));
  });

  const refreshTimestamps = new Map<string, number>();
  app.openapi(createRoute({ method: 'post', path: '/{id}/refresh', tags: ['users'], summary: '刷新用户缓存', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'UserResponse', content: { 'application/json': { schema: OkResponse(UserResponseSchema) } } } } }), async (c) => {
    const id = createUserId(c.req.param('id'));
    const now = Date.now();
    const last = refreshTimestamps.get(id);
    if (last !== undefined && now - last < 3_600_000) throw new AppError(429, 'RATE_LIMITED', 'Can refresh once per hour');
    refreshTimestamps.set(id, now);
    const user = await userService.refresh(id);
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    return c.json(ok(userToResponse(user)));
  });

  app.openapi(createRoute({ method: 'get', path: '/', tags: ['users'], summary: '列出所有用户', responses: { 200: { description: 'UserResponse[]', content: { 'application/json': { schema: PaginatedResponse(UserResponseSchema) } } } } }), async (c) => {
    const page = parseInt(c.req.query('page') ?? '') || 1;
    const limit = parseInt(c.req.query('limit') ?? '') || 50;
    const { items, total } = await userService.listPaginated(page, limit);
    return c.json(ok({ items: items.map(userToResponse), total, page, limit }));
  });

  app.openapi(createRoute({ method: 'get', path: '/search', tags: ['users'], summary: '搜索用户', responses: { 200: { description: 'User | null', content: { 'application/json': { schema: OkResponse(z.union([UserResponseSchema, z.null()])) } } } } }), async (c) => {
    const q = c.req.query('q');
    if (!q) throw new AppError(400, 'VALIDATION_ERROR', 'query parameter q is required');
    const atomic = c.var.stores.atomic;
    let user;
    if (q.includes('@')) { const e = await atomic.get<any>('user:email:' + q); if (e) user = e.value; }
    else { const e = await atomic.get<any>('user:' + q); if (e) user = e.value; }
    if (!user) return c.json(ok(null));
    return c.json(ok(userToResponse(user)));
  });

  app.openapi(createRoute({ method: 'get', path: '/{id}/login-policy', tags: ['users'], summary: '获取用户登录策略', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'LoginPolicy', content: { 'application/json': { schema: OkResponse(LoginPolicySchema) } } } } }), async (c) => {
    const id = createUserId(c.req.param('id'));
    const user = await userService.getById(id);
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    return c.json(ok(user.loginPolicy ?? { enabled: true, timeRanges: [], allowedCIDRs: [] }));
  });

  app.openapi(createRoute({ method: 'put', path: '/{id}/login-policy', tags: ['users'], summary: '更新用户登录策略', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'LoginPolicy', content: { 'application/json': { schema: OkResponse(LoginPolicySchema.nullable()) } } } } }), async (c) => {
    const id = createUserId(c.req.param('id'));
    await requirePerm(c, permissionChecker, 'update', 'user', id);
    const body = await LoginPolicySchema.parse(c.req.json());
    const user = await userService.update(id, { name: undefined, password: undefined, role: undefined, loginPolicy: body, publicKeyEd25519: undefined, gecos: undefined, directory: undefined, shell: undefined, supplementaryGids: undefined });
    return c.json(ok(user.loginPolicy ?? null));
  });

  app.openapi(createRoute({ method: 'delete', path: '/{id}/login-policy', tags: ['users'], summary: '清除用户登录策略', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: OkResponse(z.null()) } } } } }), async (c) => {
    const id = createUserId(c.req.param('id'));
    await requirePerm(c, permissionChecker, 'update', 'user', id);
    await userService.clearLoginPolicy(id, c.var.currentUser?.id);
    return c.json(ok(null));
  });

  app.openapi(createRoute({ method: 'get', path: '/{id}/public-key', tags: ['users'], summary: '获取用户 Ed25519 公钥', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'string | null', content: { 'application/json': { schema: OkResponse(z.union([z.string(), z.null()])) } } } } }), async (c) => {
    const id = createUserId(c.req.param('id'));
    const user = await userService.getById(id);
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    return c.json(ok(user.publicKeyEd25519 ?? null));
  });

  app.openapi(createRoute({ method: 'put', path: '/{id}/public-key', tags: ['users'], summary: '设置用户 Ed25519 公钥', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'string', content: { 'application/json': { schema: OkResponse(z.union([z.string(), z.null()])) } } } } }), async (c) => {
    const id = createUserId(c.req.param('id'));
    const data = await z.object({ publicKey: PublicKeySchema }).parse(c.req.json());
    await requirePerm(c, permissionChecker, 'update', 'user', id);
    const user = await userService.update(id, { name: undefined, password: undefined, role: undefined, loginPolicy: undefined, publicKeyEd25519: data.publicKey, gecos: undefined, directory: undefined, shell: undefined, supplementaryGids: undefined });
    return c.json(ok(user.publicKeyEd25519 ?? null));
  });

  app.openapi(createRoute({ method: 'delete', path: '/{id}/public-key', tags: ['users'], summary: '清除用户 Ed25519 公钥', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: OkResponse(z.null()) } } } } }), async (c) => {
    const id = createUserId(c.req.param('id'));
    await requirePerm(c, permissionChecker, 'update', 'user', id);
    await userService.clearPublicKey(id, c.var.currentUser?.id);
    return c.json(ok(null));
  });

  app.openapi(createRoute({ method: 'get', path: '/{id}/avatar', tags: ['users'], summary: '获取用户头像', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'image/*' } } }), async (c) => {
    const rawId = c.req.param('id');
    let targetId: ReturnType<typeof createUserId>;
    try { targetId = createUserId(rawId); } catch { throw new AppError(400, 'VALIDATION_ERROR', 'Invalid user ID'); }
    const blobStore = c.var.stores.blob;
    const atomic = c.var.stores.atomic;
    const metaEntry = await atomic.get<{ contentType: string }>(AVATAR_META_PREFIX + targetId);
    const stream = await blobStore.get(AVATAR_BLOB_PREFIX + targetId);
    if (!stream) throw new AppError(404, 'AVATAR_NOT_FOUND', 'No avatar');
    return new Response(stream as any, { status: 200, headers: { 'Content-Type': metaEntry?.value.contentType ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' } });
  });

  app.openapi(createRoute({ method: 'put', path: '/{id}/avatar', tags: ['users'], summary: '上传用户头像', request: { params: z.object({ id: z.string() }) }, responses: { 201: { description: '{ size, contentType }', content: { 'application/json': { schema: OkResponse(z.object({ size: z.number(), contentType: z.string() })) } } } } }), async (c) => {
    const user = c.var.currentUser;
    if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    const rawId = c.req.param('id');
    let targetId: ReturnType<typeof createUserId>;
    try { targetId = createUserId(rawId); } catch { throw new AppError(400, 'VALIDATION_ERROR', 'Invalid user ID'); }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
    const isAdmin = user.role === UserRole.Root || user.role === UserRole.Operator;
    if (user.id !== targetId && !isAdmin) throw new AppError(403, 'FORBIDDEN', 'Can only upload your own avatar');
    const blob = await c.req.blob();
    if (blob.size > AVATAR_MAX_SIZE) throw new AppError(413, 'AVATAR_TOO_LARGE', `Avatar must be under ${String(AVATAR_MAX_SIZE / 1024)} KB`);
    if (blob.size === 0) throw new AppError(400, 'AVATAR_EMPTY', 'Avatar cannot be empty');
    const buf = new Uint8Array(await blob.arrayBuffer());
    const detectedType = detectImageType(buf);
    if (!detectedType) throw new AppError(415, 'AVATAR_INVALID', 'File is not a valid image (JPEG/PNG/WebP/GIF)');
    const declaredType = blob.type;
    if (declaredType && !ALLOWED_MIME.has(declaredType)) throw new AppError(415, 'AVATAR_UNSUPPORTED_TYPE', `Unsupported image type: ${declaredType}`);
    const blobStore = c.var.stores.blob;
    const atomic = c.var.stores.atomic;
    await blobStore.put(AVATAR_BLOB_PREFIX + targetId, buf as any, { contentType: detectedType, contentLength: buf.length });
    const metaEntry = await atomic.get<{ contentType: string; size: number; updatedAt: number }>(AVATAR_META_PREFIX + targetId);
    await atomic.set(AVATAR_META_PREFIX + targetId, { contentType: detectedType, size: buf.length, updatedAt: Date.now() }, metaEntry?.version ?? null);
    return c.json(ok({ size: buf.length, contentType: detectedType }), 201);
  });

  app.openapi(createRoute({ method: 'delete', path: '/{id}/avatar', tags: ['users'], summary: '删除用户头像', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: OkResponse(z.null()) } } } } }), async (c) => {
    const user = c.var.currentUser;
    if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    const rawId = c.req.param('id');
    let targetId: ReturnType<typeof createUserId>;
    try { targetId = createUserId(rawId); } catch { throw new AppError(400, 'VALIDATION_ERROR', 'Invalid user ID'); }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
    const isAdmin = user.role === UserRole.Root || user.role === UserRole.Operator;
    if (user.id !== targetId && !isAdmin) throw new AppError(403, 'FORBIDDEN', 'Can only delete your own avatar');
    const blobStore = c.var.stores.blob;
    const atomic = c.var.stores.atomic;
    await blobStore.delete(AVATAR_BLOB_PREFIX + targetId);
    const metaEntry = await atomic.get<any>(AVATAR_META_PREFIX + targetId);
    if (metaEntry) await atomic.set(AVATAR_META_PREFIX + targetId, null, metaEntry.version);
    return c.json(ok(null));
  });

  app.openapi(createRoute({ method: 'get', path: '/sessions', tags: ['users'], summary: '列出活跃 session', responses: { 200: { description: 'Session[]', content: { 'application/json': { schema: OkResponse(z.array(z.object({ token: z.string(), tokenHint: z.string() }))) } } } } }), async (c) => {
    const user = c.var.currentUser;
    if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    const targetId = c.req.query('userId');
    const userId = (targetId && (user.role === 'root' || user.role === 'Operator')) ? createUserId(targetId) : createUserId(user.id);
    const sessions = await userService.listSessions(userId);
    return c.json(ok(sessions.map(s => ({ token: s, tokenHint: s.slice(-4) }))));
  });

  app.openapi(createRoute({ method: 'delete', path: '/sessions/{token}', tags: ['users'], summary: '吊销 session', request: { params: z.object({ token: z.string() }) }, responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: OkResponse(z.null()) } } } } }), async (c) => {
    const user = c.var.currentUser;
    if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    await requirePerm(c, permissionChecker, 'update', 'user', user.id);
    await userService.revokeSession(createSessionToken(c.req.param('token')), user.id);
    return c.json(ok(null));
  });

  app.openapi(createRoute({ method: 'get', path: '/{id}/supplementary-groups', tags: ['users'], summary: '列出用户辅助组 GID', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'number[]', content: { 'application/json': { schema: OkResponse(z.array(z.number())) } } } } }), async (c) => {
    const id = createUserId(c.req.param('id'));
    const gids = await userService.listSupplementaryGroups(id);
    return c.json(ok(gids));
  });

  app.openapi(createRoute({ method: 'put', path: '/{id}/supplementary-groups/{gid}', tags: ['users'], summary: '添加辅助组', request: { params: z.object({ id: z.string(), gid: z.string() }) }, responses: { 200: { description: 'UserResponse', content: { 'application/json': { schema: OkResponse(UserResponseSchema) } } } } }), async (c) => {
    const id = createUserId(c.req.param('id'));
    const gid = parseInt(c.req.param('gid'));
    if (isNaN(gid) || gid < 0) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid GID');
    await requirePerm(c, permissionChecker, 'update', 'user', id);
    const user = await userService.addSupplementaryGroup(id, createGid(gid), c.var.currentUser?.id);
    return c.json(ok(userToResponse(user)));
  });

  app.openapi(createRoute({ method: 'delete', path: '/{id}/supplementary-groups/{gid}', tags: ['users'], summary: '移除辅助组', request: { params: z.object({ id: z.string(), gid: z.string() }) }, responses: { 200: { description: 'UserResponse', content: { 'application/json': { schema: OkResponse(UserResponseSchema) } } } } }), async (c) => {
    const id = createUserId(c.req.param('id'));
    const gid = parseInt(c.req.param('gid'));
    if (isNaN(gid) || gid < 0) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid GID');
    await requirePerm(c, permissionChecker, 'update', 'user', id);
    const user = await userService.removeSupplementaryGroup(id, createGid(gid), c.var.currentUser?.id);
    return c.json(ok(userToResponse(user)));
  });

  app.openapi(createRoute({ method: 'post', path: '/no-password-login', tags: ['users'], summary: '无密码登录', request: { body: { content: { 'application/json': { schema: NoPasswordLoginSchema } } } }, responses: { 200: { description: 'LoginResponse', content: { 'application/json': { schema: OkResponse(LoginResponseSchema) } } } } }), async (c) => {
    const data = await NoPasswordLoginSchema.parse(c.req.json());
    const loginIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('cf-connecting-ip');
    const siteContext = c.req.header('origin') ?? c.req.header('referer') ?? '';
    const { user, token } = await userService.loginNoPassword({ email: data.email, oneTimeKey: data.oneTimeKey }, { ip: loginIp, siteContext });
    return c.json(ok(LoginResponseSchema.parse({ token, user: userToResponse(user) })));
  });

  return app;
}
