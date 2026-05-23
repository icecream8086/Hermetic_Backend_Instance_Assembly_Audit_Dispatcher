import type { IAtomicStore } from '../store/interfaces.ts';
import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../app.ts';
import type { IAuditWriter } from '../audit/types.ts';
import { KernLevel } from '../audit/kern-level.ts';

// ─── Context variable ───

export interface CurrentUser {
  id: string;
  role: string;
  email: string;
}

declare module '../app.ts' {
  interface AppContext {
    currentUser?: CurrentUser;
  }
}

// ─── Config ───

export interface AuthzConfig {
  store: IAtomicStore;
  /** Route access check function: (method, path, userId) → boolean. */
  checkRouteAccess?: (method: string, path: string, userId: string) => Promise<boolean>;
  /** Path prefixes that skip auth entirely. */
  publicPaths: string[];
  /** Audit writer for security events. */
  audit?: IAuditWriter | undefined;
}

// ─── Constants ───

const TOKEN_PREFIX = 'session:';
const USER_PREFIX = 'user:';
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

// ─── Middleware ───

/**
 * Token auth + route ACL middleware.
 *
 * 1. Skips public paths (register/login etc).
 * 2. Reads `Authorization: Bearer <token>`, validates the session.
 * 3. Sets `c.var.currentUser`.
 * 4. If `checkRouteAccess` is configured, checks route ACLs.
 */
export function authz(config: AuthzConfig): MiddlewareHandler<{ Variables: AppContext }> {
  return async (c, next) => {
    const path = c.req.path;
    const method = c.req.method;
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();

    function secAudit(ev: string, level: KernLevel, fields: Record<string, unknown>) {
      config.audit?.write({ level, facility: 'authz', message: ev, metadata: { eventType: ev, method, path, ip, ...fields, timestamp: Date.now() } });
    }

    // 1. Skip public paths
    if (config.publicPaths.some(p => path.startsWith(p))) {
      await next();
      return;
    }

    // 2. Extract Bearer token
    const auth = c.req.header('authorization');
    if (!auth || !auth.startsWith('Bearer ')) {
      secAudit('perm.unauthorized', KernLevel.WARNING, { reason: 'missing_auth_header' });
      return c.json({ success: false, data: null, error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' } }, 401);
    }
    const token = auth.slice(7);
    if (!token) {
      secAudit('perm.unauthorized', KernLevel.WARNING, { reason: 'empty_token' });
      return c.json({ success: false, data: null, error: { code: 'UNAUTHORIZED', message: 'Empty token' } }, 401);
    }

    // 3. Validate session
    const sessionEntry = await config.store.get<{ userId: string; createdAt: number }>(TOKEN_PREFIX + token).catch(() => null);
    if (!sessionEntry) {
      secAudit('perm.unauthorized', KernLevel.WARNING, { reason: 'invalid_token' });
      return c.json({ success: false, data: null, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } }, 401);
    }
    if (Date.now() - sessionEntry.value.createdAt > SESSION_TTL_MS) {
      secAudit('perm.unauthorized', KernLevel.WARNING, { reason: 'token_expired' });
      return c.json({ success: false, data: null, error: { code: 'UNAUTHORIZED', message: 'Token expired' } }, 401);
    }

    // 4. Get user
    const uid = sessionEntry.value.userId;
    const userEntry = await config.store.get<any>(USER_PREFIX + uid).catch(() => null);
    if (!userEntry) {
      secAudit('perm.unauthorized', KernLevel.WARNING, { reason: 'user_not_found', userId: uid });
      return c.json({ success: false, data: null, error: { code: 'UNAUTHORIZED', message: 'User not found' } }, 401);
    }

    // 5. Set user context
    c.set('currentUser', { id: uid, role: userEntry.value.role ?? '', email: userEntry.value.email ?? '' });

    // 6. Route ACL check
    if (config.checkRouteAccess) {
      const allowed = await config.checkRouteAccess(method, path, uid);
      if (!allowed) {
        secAudit('perm.forbidden', KernLevel.NOTICE, { userId: uid, reason: 'no_matching_acl' });
        return c.json({ success: false, data: null, error: { code: 'FORBIDDEN', message: 'You do not have access to this resource' } }, 403);
      }
      secAudit('perm.routeAccess', KernLevel.INFO, { userId: uid, allowed: true });
    }

    await next();
  };
}
