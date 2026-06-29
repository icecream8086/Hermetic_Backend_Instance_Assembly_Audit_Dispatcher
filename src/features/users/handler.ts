import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../../core/deps.ts';
import type { IUserService } from './service.ts';
import type { RouteMeta } from '../../core/http-docs/types.ts';
import { RegisterUserSchema, LoginUserSchema, UpdateUserSchema, UserResponseSchema, LoginResponseSchema, LoginPolicySchema, NoPasswordLoginSchema, PublicKeySchema } from './schema.ts';
import type { UserResponse } from './schema.ts';
import { createUserId, createSessionToken, createGid, UserRole } from './types.ts';
import { ok, fail } from '../../core/response.ts';

// ─── Avatar constants ───
const AVATAR_MAX_SIZE = 1048576; // 1 MB
const AVATAR_META_PREFIX = 'avatar:meta:';
const AVATAR_BLOB_PREFIX = 'avatar:';
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** Minimal magic-byte detection for uploaded images. */
function detectImageType(buf: Uint8Array): string | null {
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
    if (buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp'; // RIFF + WEBP
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  return null;
}

// ─── Response helpers ───

function userToResponse(user: { id: string; email: string; name: string; role: UserRole; uid?: number; gid?: number; gecos?: string; directory?: string; shell?: string; supplementaryGids?: number[]; createdAt: number; updatedAt: number }): UserResponse {
  return UserResponseSchema.parse({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    uid: (user as any).uid ?? 1000,
    gid: (user as any).gid ?? 1000,
    gecos: (user as any).gecos ?? user.name,
    directory: (user as any).directory ?? `/home/${user.email}`,
    shell: (user as any).shell ?? '/bin/bash',
    supplementaryGids: (user as any).supplementaryGids ?? [],
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  });
}

interface PermissionCheckFn { check(params: { userId: string; action: string; resource: string; ip?: string; resourceOwnerId?: string }): Promise<{ allowed: boolean; reason: string }> }

interface UsersEnv { Variables: AppContext }

async function requirePerm(c: Context<UsersEnv>, checker: PermissionCheckFn | undefined, action: string, resource: string, resourceOwnerId?: string): Promise<Response | null> {
  if (!checker) return null;
  const user = c.var.currentUser;
  if (!user) return null;
  const result = await checker.check({ userId: user.id, action, resource, ...(resourceOwnerId ? { resourceOwnerId } : {}) });
  if (!result.allowed) return c.json(fail('FORBIDDEN', result.reason), 403);
  return null;
}

// ─── Router factory ───

export function createUserRouter(userService: IUserService, permissionChecker?: PermissionCheckFn): Hono<{ Variables: AppContext }> {
  const router = new Hono<{ Variables: AppContext }>();

  // POST /api/users/register
  // First registered user automatically becomes Root (single-user init mode).
  router.post('/register', async (c) => {
    const body: unknown = await c.req.json();
    const parsed = RegisterUserSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    }

    // First-registration gate: atomically claim the init flag.
    // Only the first concurrent request succeeds — subsequent registrations
    // are always Viewer.
    const atomic = c.var.stores.atomic;
    const initKey = '_sys:initialized';
    const initEntry = await atomic.get<boolean>(initKey);
    const isFirst = initEntry?.value !== true;
    let role = UserRole.Viewer;
    if (isFirst) {
      const claimed = await atomic.set(initKey, true, null);
      if (claimed) role = UserRole.Root;
    }

    const { user, token } = await userService.register({
      email: parsed.data.email,
      password: parsed.data.password,
      name: parsed.data.name,
      role,
    });

    return c.json(ok(LoginResponseSchema.parse({ token, user: userToResponse(user) })), 201);
  });

  // POST /api/users/login
  router.post('/login', async (c) => {
    const body: unknown = await c.req.json();
    const parsed = LoginUserSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    }

    const loginIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('cf-connecting-ip');
    const { user, token } = await userService.login(
      { email: parsed.data.email, password: parsed.data.password },
      { ip: loginIp, siteContext: undefined },
    );

    return c.json(ok(LoginResponseSchema.parse({ token, user: userToResponse(user) })));
  });

  // ─── Login info (discovery) — must be before /:id to avoid param capture ───
  router.get('/login-info', async (c) => {
    const email = c.req.query('email');
    if (!email) return c.json(fail('VALIDATION_ERROR', 'email query param required'), 400);
    const parsed = z.string().email().safeParse(email);
    if (!parsed.success) return c.json(fail('VALIDATION_ERROR', 'Valid email required'), 400);
    const info = await userService.getLoginInfo(parsed.data);
    return c.json(ok(info));
  });

  // GET /api/users/:id
  router.get('/:id', async (c) => {
    const id = createUserId(c.req.param('id'));
    const user = await userService.getById(id);
    if (!user) return c.json(fail('USER_NOT_FOUND', 'User not found'), 404);
    return c.json(ok(userToResponse(user)));
  });

  // PUT /api/users/:id
  router.put('/:id', async (c) => {
    const id = createUserId(c.req.param('id'));
    const body: unknown = await c.req.json();
    const parsed = UpdateUserSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    }
    { const r = await requirePerm(c, permissionChecker, 'update', 'user', id); if (r) return r; }

    // Construct input with all properties present (EOPT-safe)
    const data = parsed.data;
    const actorId = c.var.currentUser?.id;
    const user = await userService.update(id, {
      name: data.name,
      password: data.password,
      role: data.role,
      loginPolicy: data.loginPolicy,
      publicKeyEd25519: data.publicKeyEd25519,
      gecos: data.gecos,
      directory: data.directory,
      shell: data.shell,
      supplementaryGids: data.supplementaryGids,
    }, actorId);
    return c.json(ok(userToResponse(user)));
  });

  // DELETE /api/users/:id
  router.delete('/:id', async (c) => {
    const id = createUserId(c.req.param('id'));
    { const r = await requirePerm(c, permissionChecker, 'delete', 'user', id); if (r) return r; }
    const actorId = c.var.currentUser?.id;
    await userService.delete(id, actorId);
    return c.json(ok(null));
  });

  // POST /api/users/:id/refresh — bust cache and re-fetch from authoritative store
  const refreshTimestamps = new Map<string, number>();
  router.post('/:id/refresh', async (c) => {
    const id = createUserId(c.req.param('id'));
    const now = Date.now();
    const last = refreshTimestamps.get(id);
    if (last !== undefined && now - last < 3_600_000) {
      return c.json(fail('RATE_LIMITED', 'Can refresh once per hour'), 429);
    }
    refreshTimestamps.set(id, now);

    const user = await userService.refresh(id);
    if (!user) return c.json(fail('USER_NOT_FOUND', 'User not found'), 404);
    return c.json(ok(userToResponse(user)));
  });

  // GET /api/users — list all (paginated)
  router.get('/', async (c) => {
    const page = parseInt(c.req.query('page') ?? '') || 1;
    const limit = parseInt(c.req.query('limit') ?? '') || 50;
    const { items, total } = await userService.listPaginated(page, limit);
    return c.json(ok({ items: items.map(userToResponse), total, page, limit }));
  });

  // GET /api/users/search?q=email-or-id — eventual-consistency lookup
  router.get('/search', async (c) => {
    const q = c.req.query('q');
    if (!q) return c.json(fail('VALIDATION_ERROR', 'query parameter q is required'), 400);
    const atomic = c.var.stores.atomic;
    let user;
    if (q.includes('@')) {
      const entry = await atomic.get<any>('user:email:' + q);
      if (entry) user = entry.value;
    } else {
      const entry = await atomic.get<any>('user:' + q);
      if (entry) user = entry.value;
    }
    if (!user) return c.json(ok(null));
    return c.json(ok(userToResponse(user)));
  });

  // ─── Login policy CRUD ───
  router.get('/:id/login-policy', async (c) => {
    const id = createUserId(c.req.param('id'));
    const user = await userService.getById(id);
    if (!user) return c.json(fail('USER_NOT_FOUND', 'User not found'), 404);
    return c.json(ok(user.loginPolicy ?? { enabled: true, timeRanges: [], allowedCIDRs: [] }));
  });

  router.put('/:id/login-policy', async (c) => {
    const id = createUserId(c.req.param('id'));
    { const r = await requirePerm(c, permissionChecker, 'update', 'user', id); if (r) return r; }
    const body: unknown = await c.req.json();
    const parsed = LoginPolicySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    }
    const user = await userService.update(id, {
      name: undefined, password: undefined, role: undefined,
      loginPolicy: parsed.data,
      publicKeyEd25519: undefined,
      gecos: undefined, directory: undefined, shell: undefined, supplementaryGids: undefined,
    });
    return c.json(ok(user.loginPolicy ?? null));
  });

  router.delete('/:id/login-policy', async (c) => {
    const id = createUserId(c.req.param('id'));
    { const r = await requirePerm(c, permissionChecker, 'update', 'user', id); if (r) return r; }
    const actorId = c.var.currentUser?.id;
    await userService.clearLoginPolicy(id, actorId);
    return c.json(ok(null));
  });

  // ─── Public key CRUD ───
  router.get('/:id/public-key', async (c) => {
    const id = createUserId(c.req.param('id'));
    const user = await userService.getById(id);
    if (!user) return c.json(fail('USER_NOT_FOUND', 'User not found'), 404);
    return c.json(ok(user.publicKeyEd25519 ?? null));
  });

  router.put('/:id/public-key', async (c) => {
    const id = createUserId(c.req.param('id'));
    const body: unknown = await c.req.json();
    const data = z.object({ publicKey: PublicKeySchema }).parse(body);
    { const r = await requirePerm(c, permissionChecker, 'update', 'user', id); if (r) return r; }
    const user = await userService.update(id, {
      name: undefined, password: undefined, role: undefined,
      loginPolicy: undefined, publicKeyEd25519: data.publicKey,
      gecos: undefined, directory: undefined, shell: undefined, supplementaryGids: undefined,
    });
    return c.json(ok(user.publicKeyEd25519 ?? null));
  });

  router.delete('/:id/public-key', async (c) => {
    const id = createUserId(c.req.param('id'));
    { const r = await requirePerm(c, permissionChecker, 'update', 'user', id); if (r) return r; }
    const actorId = c.var.currentUser?.id;
    await userService.clearPublicKey(id, actorId);
    return c.json(ok(null));
  });

  // ─── Avatar ───

  router.get('/:id/avatar', async (c) => {
    const rawId = c.req.param('id');
    let targetId: ReturnType<typeof createUserId>;
    try { targetId = createUserId(rawId); } catch { return c.json(fail('VALIDATION_ERROR', 'Invalid user ID'), 400); }
    const blobStore = c.var.stores.blob;
    const atomic = c.var.stores.atomic;
    const metaEntry = await atomic.get<{ contentType: string }>(AVATAR_META_PREFIX + targetId);
    const stream = await blobStore.get(AVATAR_BLOB_PREFIX + targetId);
    if (!stream) return c.json(fail('AVATAR_NOT_FOUND', 'No avatar'), 404);
    return new Response(stream as any, {
      status: 200,
      headers: {
        'Content-Type': metaEntry?.value.contentType ?? 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  });

  router.put('/:id/avatar', async (c) => {
    const user = c.var.currentUser;
    if (!user) return c.json(fail('UNAUTHORIZED', 'Authentication required'), 401);
    const rawId = c.req.param('id');
    let targetId: ReturnType<typeof createUserId>;
    try { targetId = createUserId(rawId); } catch { return c.json(fail('VALIDATION_ERROR', 'Invalid user ID'), 400); }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison -- UserRole is a string enum
    const isAdmin = user.role === UserRole.Root || user.role === UserRole.Operator;
    if (user.id !== targetId && !isAdmin) {
      return c.json(fail('FORBIDDEN', 'Can only upload your own avatar'), 403);
    }

    // Read raw body (Hono buffers multipart; we use it as bytes)
    const blob = await c.req.blob();
    if (blob.size > AVATAR_MAX_SIZE) {
      return c.json(fail('AVATAR_TOO_LARGE', `Avatar must be under ${String(AVATAR_MAX_SIZE / 1024)} KB`), 413);
    }
    if (blob.size === 0) {
      return c.json(fail('AVATAR_EMPTY', 'Avatar cannot be empty'), 400);
    }

    // Validate magic bytes first (before trusting Content-Type)
    const buf = new Uint8Array(await blob.arrayBuffer());
    const detectedType = detectImageType(buf);
    if (!detectedType) {
      return c.json(fail('AVATAR_INVALID', 'File is not a valid image (JPEG/PNG/WebP/GIF)'), 415);
    }

    // Cross-check with declared Content-Type (if provided)
    const declaredType = blob.type;
    if (declaredType && !ALLOWED_MIME.has(declaredType)) {
      return c.json(fail('AVATAR_UNSUPPORTED_TYPE', `Unsupported image type: ${declaredType}`), 415);
    }

    // Store to blob store
    const blobStore = c.var.stores.blob;
    const atomic = c.var.stores.atomic;
    const blobKey = AVATAR_BLOB_PREFIX + targetId;
    const metaKey = AVATAR_META_PREFIX + targetId;

    await blobStore.put(blobKey, buf as any, { contentType: detectedType, contentLength: buf.length });

    // Track metadata in atomic store
    const metaEntry = await atomic.get<{ contentType: string; size: number; updatedAt: number }>(metaKey);
    await atomic.set(metaKey, { contentType: detectedType, size: buf.length, updatedAt: Date.now() }, metaEntry?.version ?? null);

    return c.json(ok({ size: buf.length, contentType: detectedType }), 201);
  });

  router.delete('/:id/avatar', async (c) => {
    const user = c.var.currentUser;
    if (!user) return c.json(fail('UNAUTHORIZED', 'Authentication required'), 401);
    const rawId = c.req.param('id');
    let targetId: ReturnType<typeof createUserId>;
    try { targetId = createUserId(rawId); } catch { return c.json(fail('VALIDATION_ERROR', 'Invalid user ID'), 400); }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison -- UserRole is a string enum
    const isAdmin = user.role === UserRole.Root || user.role === UserRole.Operator;
    if (user.id !== targetId && !isAdmin) {
      return c.json(fail('FORBIDDEN', 'Can only delete your own avatar'), 403);
    }

    const blobStore = c.var.stores.blob;
    const atomic = c.var.stores.atomic;
    await blobStore.delete(AVATAR_BLOB_PREFIX + targetId);
    const metaEntry = await atomic.get<any>(AVATAR_META_PREFIX + targetId);
    if (metaEntry) await atomic.set(AVATAR_META_PREFIX + targetId, null, metaEntry.version);
    return c.json(ok(null));
  });

  // ─── Session management ───
  // Static routes before /:id to avoid Hono matching 'sessions' as a user ID.

  router.get('/sessions', async (c) => {
    const user = c.var.currentUser;
    if (!user) return c.json(fail('UNAUTHORIZED', 'Authentication required'), 401);

    // Admin can query any user's sessions; users see only their own
    const targetId = c.req.query('userId');
    const userId = (targetId && (user.role === 'root' || user.role === 'Operator'))
      ? createUserId(targetId)
      : createUserId(user.id);

    const sessions = await userService.listSessions(userId);
    return c.json(ok(sessions.map(s => ({
      token: s,
      // Last 4 chars for identification, not full token
      tokenHint: s.slice(-4),
    }))));
  });

  router.delete('/sessions/:token', async (c) => {
    const user = c.var.currentUser;
    if (!user) return c.json(fail('UNAUTHORIZED', 'Authentication required'), 401);
    { const r = await requirePerm(c, permissionChecker, 'update', 'user', user.id); if (r) return r; }

    const token = createSessionToken(c.req.param('token'));
    await userService.revokeSession(token, user.id);
    return c.json(ok(null));
  });

  // ─── Supplementary groups (RHEL §1 supp_groups) ───

  router.get('/:id/supplementary-groups', async (c) => {
    const id = createUserId(c.req.param('id'));
    const gids = await userService.listSupplementaryGroups(id);
    return c.json(ok(gids));
  });

  router.put('/:id/supplementary-groups/:gid', async (c) => {
    const id = createUserId(c.req.param('id'));
    const gid = parseInt(c.req.param('gid'));
    if (isNaN(gid) || gid < 0) return c.json(fail('VALIDATION_ERROR', 'Invalid GID'), 400);
    { const r = await requirePerm(c, permissionChecker, 'update', 'user', id); if (r) return r; }
    const actorId = c.var.currentUser?.id;
    const user = await userService.addSupplementaryGroup(id, createGid(gid), actorId);
    return c.json(ok(userToResponse(user)));
  });

  router.delete('/:id/supplementary-groups/:gid', async (c) => {
    const id = createUserId(c.req.param('id'));
    const gid = parseInt(c.req.param('gid'));
    if (isNaN(gid) || gid < 0) return c.json(fail('VALIDATION_ERROR', 'Invalid GID'), 400);
    { const r = await requirePerm(c, permissionChecker, 'update', 'user', id); if (r) return r; }
    const actorId = c.var.currentUser?.id;
    const user = await userService.removeSupplementaryGroup(id, createGid(gid), actorId);
    return c.json(ok(userToResponse(user)));
  });

  // ─── No-password login ───
  router.post('/no-password-login', async (c) => {
    const body: unknown = await c.req.json();
    const data = NoPasswordLoginSchema.parse(body);
    const loginIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('cf-connecting-ip');
    const siteContext = c.req.header('origin') ?? c.req.header('referer') ?? '';
    const { user, token } = await userService.loginNoPassword(
      { email: data.email, oneTimeKey: data.oneTimeKey },
      { ip: loginIp, siteContext },
    );
    return c.json(ok(LoginResponseSchema.parse({ token, user: userToResponse(user) })));
  });

  return router;
}

export const userRouteMeta: RouteMeta[] = [
  {
    method: 'POST',
    path: '/register',
    description: '注册新用户 — 密码至少 8 位，自动加入 "users" 组获得基本权限。返回 token 用于后续请求的 Authorization 头',
    requestBody: { email: 'user@example.com', password: 'secret123', name: 'Alice', role: 'Viewer' },
    responseDescription: 'LoginResponse — token + user',
  },
  {
    method: 'POST',
    path: '/login',
    description: '用户登录 — 校验密码，返回 token。公开端点不需要 Authorization 头',
    requestBody: { email: 'user@example.com', password: 'secret123' },
    responseDescription: 'LoginResponse — token + user',
  },
  {
    method: 'GET',
    path: '/login-info',
    description: '查询邮箱的登录方式（password / no-password 等）',
    responseDescription: 'LoginInfo — { exists, methods, policy }',
    queryExamples: [{ email: 'user@example.com' }],
  },
  {
    method: 'POST',
    path: '/no-password-login',
    description: '无密码登录（使用 oneTimeKey）',
    requestBody: { email: 'user@example.com', oneTimeKey: '...' },
    responseDescription: 'LoginResponse — token + user',
  },
  {
    method: 'GET',
    path: '/:id',
    description: '按 ID 获取用户',
    responseDescription: 'UserResponse',
  },
  {
    method: 'PUT',
    path: '/:id',
    description: '更新用户信息',
    requestBody: { name: 'New Name', role: 'Viewer', publicKeyEd25519: 'base64-pubkey' },
    responseDescription: 'UserResponse',
  },
  {
    method: 'POST',
    path: '/:id/refresh',
    description: '清除 KV 缓存并回源 DO 读取最新用户（1h 限频）',
    responseDescription: 'UserResponse',
  },
  {
    method: 'DELETE',
    path: '/:id',
    description: '删除用户',
    responseDescription: '{ ok: true }',
  },
  {
    method: 'GET',
    path: '/',
    description: '列出所有用户',
    responseDescription: 'UserResponse[]',
  },
  {
    method: 'GET',
    path: '/:id/login-policy',
    description: '获取用户登录策略',
    responseDescription: 'LoginPolicy | null',
  },
  {
    method: 'PUT',
    path: '/:id/login-policy',
    description: '更新用户登录策略',
    requestBody: { enabled: true, timeRanges: [], allowedCIDRs: [] },
    responseDescription: 'LoginPolicy',
  },
  {
    method: 'DELETE',
    path: '/:id/login-policy',
    description: '清除用户登录策略',
    responseDescription: '{ ok: true }',
  },
  {
    method: 'GET',
    path: '/:id/public-key',
    description: '获取用户 Ed25519 公钥',
    responseDescription: 'string | null',
  },
  {
    method: 'PUT',
    path: '/:id/public-key',
    description: '设置用户 Ed25519 公钥',
    requestBody: { publicKey: 'base64-ed25519-public-key' },
    responseDescription: 'string',
  },
  {
    method: 'DELETE',
    path: '/:id/public-key',
    description: '清除用户 Ed25519 公钥',
    responseDescription: '{ ok: true }',
  },
  {
    method: 'GET',
    path: '/:id/avatar',
    description: '获取用户头像（公开，无认证要求）',
    responseDescription: 'image/* binary — 404 if no avatar',
  },
  {
    method: 'PUT',
    path: '/:id/avatar',
    description: '上传用户头像（multipart, max 1MB, JPEG/PNG/WebP/GIF）',
    requestBody: 'binary image data',
    responseDescription: '{ size, contentType }',
  },
  {
    method: 'DELETE',
    path: '/:id/avatar',
    description: '删除用户头像',
    responseDescription: '{ ok: true }',
  },
  {
    method: 'GET',
    path: '/sessions',
    description: '列出当前用户的活跃 session。管理员可加 ?userId= 查看任意用户',
    responseDescription: 'Session[] — token, tokenHint',
  },
  {
    method: 'DELETE',
    path: '/sessions/:token',
    description: '吊销指定 session（从 store 删除 + 从用户索引移除）',
    responseDescription: '{ ok: true }',
  },
  {
    method: 'GET',
    path: '/search',
    description: '按邮箱或 UID 查询用户（最终一致性，?q=email 或 ?q=userId）',
    responseDescription: 'User | null',
  },
  {
    method: 'GET',
    path: '/:id/supplementary-groups',
    description: '列出用户的辅助组 GID 列表（RHEL §1 supp_groups）',
    responseDescription: 'number[] — GID 列表',
  },
  {
    method: 'PUT',
    path: '/:id/supplementary-groups/:gid',
    description: '添加辅助组到用户（RHEL §1 supp_groups）',
    responseDescription: 'UserResponse',
  },
  {
    method: 'DELETE',
    path: '/:id/supplementary-groups/:gid',
    description: '从用户移除辅助组',
    responseDescription: 'UserResponse',
  },
];
