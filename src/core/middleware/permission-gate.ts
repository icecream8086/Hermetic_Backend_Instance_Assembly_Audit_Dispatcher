/**
 * Permission gate middleware — 3-layer security check (RHEL-aligned).
 *
 * This middleware is installed at FILTER.INPUT and enforces:
 *   Layer 1 (DAC):        user existence + resource ownership
 *   Layer 2 (Capability):  capability bitfield check
 *   Layer 3 (MAC):         DAG-based deny-override policies
 *
 * Each rejection logs an audit event with the correct audit type:
 *   DAC → SYSCALL, Capability → CAPABILITIES, MAC → AVC
 *
 * The PermissionChecker holds an in-memory cache (TTL 5s) of policies,
 * user groups, and permission groups — no per-request DB fetch overhead.
 */

import type { MiddlewareHandler } from 'hono';
import type { IPermissionChecker } from '../permission/interfaces.ts';

export interface PermissionGateOptions {
  /** Skip permission check for these paths (e.g. health, login). */
  readonly skipPaths?: readonly string[];
  /** Skip permission check for these methods (e.g. OPTIONS). */
  readonly skipMethods?: readonly string[];
}

export function createPermissionGate(
  checker: IPermissionChecker,
  options: PermissionGateOptions = {},
): MiddlewareHandler {
  const skipPaths = new Set(options.skipPaths ?? [
    '/api/auth/login',
    '/api/auth/register',
    '/api/info',
    '/health',
    '/__tick',
  ]);
  const skipMethods = new Set(options.skipMethods ?? ['OPTIONS', 'HEAD']);

  return async (c, next) => {
    const method = c.req.method;
    const path = c.req.path;

    // Skip non-guarded paths
    if (skipMethods.has(method)) return next();
    for (const p of skipPaths) {
      if (path === p || path.startsWith(p + '/') || path.startsWith(p + '?')) return next();
    }

    const userId = c.get?.('userId');
    // No user context — let the auth middleware handle rejection
    if (!userId) return next();

    const action = methodToAction(method);
    const resource = pathToResource(path);
    const ip = c.req.header?.('CF-Connecting-IP') ?? c.req.header?.('x-forwarded-for')?.split(',')[0]?.trim();

    const result = await checker.check({
      actor: userId,
      action,
      resource,
      resourceId: '',
      context: { ip, method, path },
    });

    if (result.allowed) return next();

    // Audit is auto-written by PermissionChecker on denial (SPEC: denial → record invariant).
    // HTTP context (path, method, ip) is passed in PermissionCheck.context.

    return c.json({
      error: 'FORBIDDEN',
      message: result.reason,
      ...(result.layer ? { layer: result.layer } : {}),
    }, 403);
  };
}

/** Map HTTP method to a CRUD action for permission checking. */
function methodToAction(method: string): string {
  switch (method) {
    case 'GET': return 'read';
    case 'POST': return 'create';
    case 'PUT': case 'PATCH': return 'update';
    case 'DELETE': return 'delete';
    default: return method.toLowerCase();
  }
}

/** Extract a stable resource name from the URL path. */
function pathToResource(path: string): string {
  // Strip /api/ prefix and take the first segment
  const clean = path.replace(/^\/api\//, '');
  const seg = clean.split('/')[0] ?? '';
  // Map known routes to permission resources
  const mapping: Record<string, string> = {
    'actions': 'action:workflow',
    'sandboxes': 'sandbox',
    'users': 'user',
    'permissions': 'permission',
    'templates': 'template',
    'images': 'image',
    'volumes': 'volume',
    'networks': 'network',
    'subnets': 'subnet',
    'dns': 'dns',
    'secrets': 'secret',
    'topology': 'topology',
    'platforms': 'platform',
  };
  return mapping[seg] ?? seg;
}
