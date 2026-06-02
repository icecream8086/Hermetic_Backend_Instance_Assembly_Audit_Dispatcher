import { Hono } from 'hono';
import type { IAuditReader, AuditFilter } from './types.ts';
import { KernLevel } from './kern-level.ts';
import { ok, fail } from '../response.ts';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 500;

function intParam(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
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
 * 审计日志查询路由 — Cloudflare Log API CRUD 转发层。
 *
 * 查询穿透到 IAuditReader。需要 root 权限访问。
 */
export function createAuditRouter(reader: IAuditReader): Hono {
  const router = new Hono();

  router.get('/logs', (c) => {
    { const r = requireRoot(c); if (r) return r; }

    const filter: AuditFilter = {};
    const levelMin = c.req.query('levelMin');
    const levelMax = c.req.query('levelMax');
    if (levelMin !== undefined) filter.levelMin = intParam(levelMin, 0, 0, 7) as KernLevel;
    if (levelMax !== undefined) filter.levelMax = intParam(levelMax, 7, 0, 7) as KernLevel;
    if (c.req.query('facility')) filter.facility = c.req.query('facility')!;
    if (c.req.query('search')) filter.search = c.req.query('search')!;
    const since = c.req.query('since');
    const until = c.req.query('until');
    if (since !== undefined) filter.since = parseInt(since, 10);
    if (until !== undefined) filter.until = parseInt(until, 10);
    filter.page = intParam(c.req.query('page'), 1, 1, 1_000_000);
    filter.limit = intParam(c.req.query('limit'), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);

    const result = reader.query(filter);
    return c.json(ok(result));
  });

  router.get('/logs/stats', (c) => {
    { const r = requireRoot(c); if (r) return r; }
    const result = reader.query({ limit: 1 });
    return c.json(ok({ count: result.total, capacity: 500 }));
  });

  return router;
}
