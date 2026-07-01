import type { IAtomicStore } from '../store/interfaces.ts';
import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../deps.ts';
import type { IAuditWriter } from '../audit/types.ts';
import { KernLevel } from '../audit/kern-level.ts';

// ─── Context variable ───

export interface CurrentUser {
  id: string;
  role: string;
  email: string;
}

declare module '../deps.ts' {
  interface AppContext {
    currentUser?: CurrentUser;
  }
}

// ─── Config ───

export interface AuthzConfig {
  /**
   * Atomic store for session/user lookups.
   * Should be wrapped with RequestCachedAtomicStore for per-request dedup.
   * Set to 'auto' to read from c.var.stores.atomic at request time.
   */
  store: IAtomicStore | 'auto';
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
    // Resolve store: use request-cached version from context when configured as 'auto'
    const store: IAtomicStore = config.store === 'auto' ? c.var.stores.atomic : config.store;

    const path = c.req.path;
    const method = c.req.method;
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();

    function secAudit(ev: string, level: KernLevel, fields: Record<string, unknown>): void {
      config.audit?.write({ level, facility: 'authz', message: ev, metadata: { eventType: ev, method, path, ip, ...fields, timestamp: Date.now() } });
    }

    // 1. Skip public paths
    // Exact/startsWith matches: skip auth for all methods (register, login, etc.)
    // Wildcard (*) matches: skip auth only for GET requests (e.g. avatar display)
    if (config.publicPaths.some(p => {
      if (p.includes('*')) {
        if (method !== 'GET') return false;
        const star = p.indexOf('*');
        const prefix = p.slice(0, star);
        const suffix = p.slice(star + 1);
        if (!suffix || !path.startsWith(prefix) || !path.endsWith(suffix)) return false;
        const middle = path.slice(prefix.length, path.length - suffix.length);
        return !middle.includes('/');
      }
      return path.startsWith(p);
    })) {
      await next();
      return;
    }

    // 2. Extract Bearer token (Authorization header, or ?token= for WebSocket)
    let token = '';
    const auth = c.req.header('authorization');
    if (auth?.startsWith('Bearer ')) {
      token = auth.slice(7);
    } else if (c.req.header('upgrade')?.toLowerCase() === 'websocket') {
      // WebSocket API can't set custom headers — fallback to query param
      token = c.req.query('token') ?? '';
      if (!token) {
        secAudit('perm.unauthorized', KernLevel.WARNING, { reason: 'missing_ws_token' });
        return c.json({ success: false, data: null, error: { code: 'UNAUTHORIZED', message: 'WebSocket requires ?token=' } }, 401);
      }
    }
    if (!token) {
      secAudit('perm.unauthorized', KernLevel.WARNING, { reason: 'missing_auth_header' });
      return c.json({ success: false, data: null, error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' } }, 401);
    }
    if (!token) {
      secAudit('perm.unauthorized', KernLevel.WARNING, { reason: 'empty_token' });
      return c.json({ success: false, data: null, error: { code: 'UNAUTHORIZED', message: 'Empty token' } }, 401);
    }

    // 3. Validate session
    let sessionEntry: { value: { userId: string; createdAt: number; expiresAt?: number }; version: VersionId } | null;
    try { sessionEntry = await store.get<{ userId: string; createdAt: number; expiresAt?: number }>(TOKEN_PREFIX + token); } catch { sessionEntry = null; }
    if (!sessionEntry) {
      secAudit('perm.unauthorized', KernLevel.WARNING, { reason: 'invalid_token' });
      return c.json({ success: false, data: null, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } }, 401);
    }
    const expiresAt = sessionEntry.value.expiresAt ?? (sessionEntry.value.createdAt + SESSION_TTL_MS);
    if (Date.now() >= expiresAt) {
      secAudit('perm.unauthorized', KernLevel.WARNING, { reason: 'token_expired' });
      return c.json({ success: false, data: null, error: { code: 'UNAUTHORIZED', message: 'Token expired' } }, 401);
    }

    // 4. Get user
    const uid = sessionEntry.value.userId;
    let userEntry: { value: any; version: VersionId } | null;
    try { userEntry = await store.get<any>(USER_PREFIX + uid); } catch { userEntry = null; }
    if (!userEntry) {
      secAudit('perm.unauthorized', KernLevel.WARNING, { reason: 'user_not_found', userId: uid });
      return c.json({ success: false, data: null, error: { code: 'UNAUTHORIZED', message: 'User not found' } }, 401);
    }

    // 5. Set user context
    c.set('currentUser', { id: uid, role: userEntry.value.role ?? '', email: userEntry.value.email ?? '' });

    // 6. Route ACL check
    const email = userEntry.value.email ?? '';
    if (config.checkRouteAccess) {
      const allowed = await config.checkRouteAccess(method, path, uid);
      if (!allowed) {
        secAudit('perm.forbidden', KernLevel.NOTICE, { userId: uid, email, reason: 'no_matching_acl' });
        return c.json({ success: false, data: null, error: { code: 'FORBIDDEN', message: 'You do not have access to this resource' } }, 403);
      }
      // perm.routeAccess 不在审计日志记录（每个成功的 API 请求都记录一次，噪音太大）
      // 可通过 log-policy 动态开启 DEBUG 级别观察
    }

    await next();
  };
}
