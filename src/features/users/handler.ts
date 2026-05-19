import { Hono } from 'hono';
import type { AppContext } from '../../core/app.ts';
import type { IUserService } from './service.ts';
import { RegisterUserSchema, LoginUserSchema, UpdateUserSchema, UserResponseSchema, LoginResponseSchema } from './schema.ts';
import type { UserResponse } from './schema.ts';
import { createUserId, UserRole } from './types.ts';

// ─── Response helpers ───

function userToResponse(user: { id: string; email: string; name: string; role: UserRole; createdAt: number; updatedAt: number }): UserResponse {
  return UserResponseSchema.parse({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  });
}

function errorBody(status: number, code: string, message: string) {
  return { status, error: code, message };
}

// ─── Router factory ───

export function createUserRouter(userService: IUserService): Hono<{ Variables: AppContext }> {
  const router = new Hono<{ Variables: AppContext }>();

  // POST /api/users/register
  router.post('/register', async (c) => {
    const body: unknown = await c.req.json();
    const parsed = RegisterUserSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(errorBody(400, 'VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    }

    const { user, token } = await userService.register({
      email: parsed.data.email,
      password: parsed.data.password,
      name: parsed.data.name,
      role: parsed.data.role,
    });

    return c.json(LoginResponseSchema.parse({ token, user: userToResponse(user) }), 201);
  });

  // POST /api/users/login
  router.post('/login', async (c) => {
    const body: unknown = await c.req.json();
    const parsed = LoginUserSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(errorBody(400, 'VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    }

    const { user, token } = await userService.login({
      email: parsed.data.email,
      password: parsed.data.password,
    });

    return c.json(LoginResponseSchema.parse({ token, user: userToResponse(user) }));
  });

  // GET /api/users/:id
  router.get('/:id', async (c) => {
    const id = createUserId(c.req.param('id'));
    const user = await userService.getById(id);
    if (!user) return c.json(errorBody(404, 'USER_NOT_FOUND', 'User not found'), 404);
    return c.json(userToResponse(user));
  });

  // PUT /api/users/:id
  router.put('/:id', async (c) => {
    const id = createUserId(c.req.param('id'));
    const body: unknown = await c.req.json();
    const parsed = UpdateUserSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(errorBody(400, 'VALIDATION_ERROR', parsed.error.issues.map(i => i.message).join('; ')), 400);
    }

    // Construct input with all properties present (EOPT-safe)
    const data = parsed.data;
    const user = await userService.update(id, {
      name: data.name,
      password: data.password,
      role: data.role,
    });
    return c.json(userToResponse(user));
  });

  // DELETE /api/users/:id
  router.delete('/:id', async (c) => {
    const id = createUserId(c.req.param('id'));
    await userService.delete(id);
    return c.json({ ok: true });
  });

  // GET /api/users
  router.get('/', async (c) => {
    const users = await userService.list();
    return c.json(users.map(userToResponse));
  });

  return router;
}
