import { Hono } from 'hono';
import type { IAuditReader, LogQuery } from './types.ts';
import { ok, fail } from '../response.ts';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 500;

function intParam(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

function requireRoot(c: any): Response | null {
  const user = c.var?.currentUser;
  if (!user) return null;
  const isRoot = user.role === 'root' || user.role === 'Operator' || user.role === 'wheel';
  if (!isRoot) return c.json(fail('FORBIDDEN', 'Admin access required'), 403);
  return null;
}

export function createAuditRouter(reader: IAuditReader): Hono {
  const router = new Hono();

  router.get('/logs', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    const afterCursor = c.req.query('afterCursor');
    const query: LogQuery = {
      facility: c.req.query('facility') ?? 'default',
      ...(afterCursor ? { afterCursor } : {}),
      ...(c.req.query('since') !== undefined ? { startTs: parseInt(c.req.query('since')!, 10) } : {}),
      ...(c.req.query('until') !== undefined ? { endTs: parseInt(c.req.query('until')!, 10) } : {}),
      limit: intParam(c.req.query('limit'), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
    };
    const result = await reader.query(query);
    return c.json(ok(result));
  });

  router.get('/logs/stats', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    const result = await reader.query({ facility: 'default', limit: 1 });
    return c.json(ok({ count: result.total ?? 0 }));
  });

  return router;
}
