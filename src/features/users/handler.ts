import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../../core/app.ts';
import type { IUserService } from './service.ts';
import type { RouteMeta } from '../../core/http-docs/types.ts';
import { RegisterUserSchema, LoginUserSchema, UpdateUserSchema, UserResponseSchema, LoginResponseSchema, LoginPolicySchema, NoPasswordLoginSchema, PublicKeySchema } from './schema.ts';
import type { UserResponse } from './schema.ts';
import { createUserId, UserRole } from './types.ts';
import { ok, fail } from '../../core/response.ts';

// ─── Response helpers ───

function userToResponse(user: { id: string; email: string; name: string; role: UserRole; createdAt: number; updatedAt: number; privateKeyEd25519?: string }): UserResponse {
  return UserResponseSchema.parse({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    privateKeyEd25519: user.privateKeyEd25519 ?? '',
  });
}

// ─── Router factory ───

export function createUserRouter(userService: IUserService): Hono<{ Variables: AppContext }> {
  const router = new Hono<{ Variables: AppContext }>();

  // POST /api/users/register
  router.post('/register', async (c) => {
    const body: unknown = await c.req.json();
    const parsed = RegisterUserSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    }

    const { user, token } = await userService.register({
      email: parsed.data.email,
      password: parsed.data.password,
      name: parsed.data.name,
      role: parsed.data.role,
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

    // Construct input with all properties present (EOPT-safe)
    const data = parsed.data;
    const user = await userService.update(id, {
      name: data.name,
      password: data.password,
      role: data.role,
      loginPolicy: data.loginPolicy,
      publicKeyEd25519: data.publicKeyEd25519,
      privateKeyEd25519: data.privateKeyEd25519,
    });
    return c.json(ok(userToResponse(user)));
  });

  // DELETE /api/users/:id
  router.delete('/:id', async (c) => {
    const id = createUserId(c.req.param('id'));
    await userService.delete(id);
    return c.json(ok(null));
  });

  // POST /api/users/:id/refresh — bust cache and re-fetch from authoritative store
  const refreshTimestamps = new Map<string, number>();
  router.post('/:id/refresh', async (c) => {
    const id = createUserId(c.req.param('id'));
    const now = Date.now();
    const last = refreshTimestamps.get(id as string);
    if (last !== undefined && now - last < 3_600_000) {
      return c.json(fail('RATE_LIMITED', 'Can refresh once per hour'), 429);
    }
    refreshTimestamps.set(id as string, now);

    const user = await userService.refresh(id);
    if (!user) return c.json(fail('USER_NOT_FOUND', 'User not found'), 404);
    return c.json(ok(userToResponse(user)));
  });

  // GET /api/users
  router.get('/', async (c) => {
    const users = await userService.list();
    return c.json(ok(users.map(userToResponse)));
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
    const body: unknown = await c.req.json();
    const parsed = LoginPolicySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    }
    const user = await userService.update(id, {
      name: undefined, password: undefined, role: undefined,
      loginPolicy: parsed.data,
      publicKeyEd25519: undefined, privateKeyEd25519: undefined,
    });
    return c.json(ok(user.loginPolicy ?? null));
  });

  router.delete('/:id/login-policy', async (c) => {
    const id = createUserId(c.req.param('id'));
    await userService.clearLoginPolicy(id);
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
    const parsed = z.object({ publicKey: PublicKeySchema }).safeParse(body);
    if (!parsed.success) {
      return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    }
    const user = await userService.update(id, {
      name: undefined, password: undefined, role: undefined,
      loginPolicy: undefined, publicKeyEd25519: parsed.data.publicKey, privateKeyEd25519: undefined,
    });
    return c.json(ok(user.publicKeyEd25519 ?? null));
  });

  router.delete('/:id/public-key', async (c) => {
    const id = createUserId(c.req.param('id'));
    await userService.clearPublicKey(id);
    return c.json(ok(null));
  });

  // ─── No-password login ───
  router.post('/no-password-login', async (c) => {
    const body: unknown = await c.req.json();
    const parsed = NoPasswordLoginSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(fail('VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    }
    const loginIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('cf-connecting-ip');
    const siteContext = c.req.header('origin') ?? c.req.header('referer') ?? '';
    const { user, token } = await userService.loginNoPassword(
      { email: parsed.data.email, oneTimeKey: parsed.data.oneTimeKey },
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
    responseDescription: 'UserResponse — 含 privateKeyEd25519',
  },
  {
    method: 'PUT',
    path: '/:id',
    description: '更新用户信息',
    requestBody: { name: 'New Name', role: 'Viewer', privateKeyEd25519: 'sk-...' },
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
];
