import { z } from 'zod';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { IAuditReader, LogQuery } from './types.ts';
import { ok, fail } from '../response.ts';
import { KernLevel, kernLevelName } from './kern-level.ts';
import {
  getPersistencePolicy,
  setPersistencePolicy,
  resetPersistencePolicy,
  buildDefaultPersistencePolicy,
  type PersistencePolicy,
  type PersistenceRule,
} from './persistence-policy.ts';
import type { AppContext } from '../deps.ts';

interface AuditEnv { Variables: AppContext }

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 500;

function intParam(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

function requireRoot(c: Context<AuditEnv>): Response | null {
  const user = c.var?.currentUser;
  if (!user) return null;
  const isRoot = user.role === 'root' || user.role === 'Operator' || user.role === 'wheel';
  if (!isRoot) return c.json(fail('FORBIDDEN', 'Admin access required'), 403);
  return null;
}

export function createAuditRouter(reader: IAuditReader): Hono<AuditEnv> {
  const router = new Hono<AuditEnv>();

  // ─── Log query ───

  router.get('/logs', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    const afterCursor = c.req.query('afterCursor');
    const pageSize = intParam(c.req.query('limit'), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const page = intParam(c.req.query('page'), 0, 0, 10000);
    const offset = afterCursor ? undefined : page * pageSize;

    const query: LogQuery = {
      ...(c.req.query('facility') ? { facility: c.req.query('facility')! } : {}),
      ...(afterCursor ? { afterCursor } : {}),
      ...(offset !== undefined ? { offset } : {}),
      ...(c.req.query('since') !== undefined ? { startTs: parseInt(c.req.query('since')!, 10) } : {}),
      ...(c.req.query('until') !== undefined ? { endTs: parseInt(c.req.query('until')!, 10) } : {}),
      limit: pageSize,
    };
    const result = await reader.query(query);
    const total = result.total ?? 0;
    const hasNext = (page + 1) * pageSize < total;
    return c.json(ok({
      entries: result.entries,
      page,
      pageSize,
      total,
      hasNext,
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    }));
  });

  router.get('/logs/stats', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    const result = await reader.query({ limit: 1, offset: 0 });
    return c.json(ok({ count: result.total ?? 0 }));
  });

  // ─── Persistence policy control ───

  /** GET /logs/persistence — view current persistence policy. */
  router.get('/logs/persistence', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    const policy = getPersistencePolicy();
    return c.json(ok(serializePolicy(policy)));
  });

  /** PUT /logs/persistence — update persistence policy. Accepts partial updates. */
  router.put('/logs/persistence', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    const userId = c.var.currentUser?.id;
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return c.json(fail('INVALID_REQUEST', 'Expected JSON body'), 400);
    }

    const current = getPersistencePolicy();

    // Merge partial updates
    const updated: PersistencePolicy = {
      enabled: z.boolean().optional().parse(body.enabled) ?? current.enabled,
      defaultMinLevel: parseLevel(body.defaultMinLevel) ?? current.defaultMinLevel,
      rules: Array.isArray(body.rules)
        ? body.rules.map((r: any, _i: number) => parseRule(r))
        : current.rules,
      updatedAt: Date.now(),
      updatedBy: userId ?? 'unknown',
    };

    setPersistencePolicy(updated);
    return c.json(ok(serializePolicy(getPersistencePolicy())));
  });

  /** POST /logs/persistence/reset — reset persistence policy to built-in defaults. */
  router.post('/logs/persistence/reset', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    const userId = c.var.currentUser?.id;
    const reset = resetPersistencePolicy();
    reset.updatedBy = userId ?? 'unknown';
    reset.updatedAt = Date.now();
    return c.json(ok(serializePolicy(reset)));
  });

  /** GET /logs/persistence/defaults — view built-in defaults without applying them. */
  router.get('/logs/persistence/defaults', async (c) => {
    { const r = requireRoot(c); if (r) return r; }
    return c.json(ok(serializePolicy(buildDefaultPersistencePolicy())));
  });

  return router;
}

// ─── Serialization helpers ───

function parseLevel(raw: unknown): KernLevel | null {
  if (typeof raw !== 'string') return null;
  const map: Record<string, KernLevel> = {
    emerg: KernLevel.EMERG, alert: KernLevel.ALERT, crit: KernLevel.CRIT,
    err: KernLevel.ERR, warning: KernLevel.WARNING, notice: KernLevel.NOTICE,
    info: KernLevel.INFO, debug: KernLevel.DEBUG,
  };
  return map[raw.toLowerCase()] ?? null;
}

function parseRule(raw: Record<string, unknown>): PersistenceRule {
  const rawFacility = String(raw.facility ?? '*');
  const sampleRate = z.number().optional().parse(raw.sampleRate);
  const ttlMs = z.number().optional().parse(raw.ttlMs);
  return {
    facility: (rawFacility === '*' ? '*' : rawFacility) as PersistenceRule['facility'],
    minLevel: parseLevel(raw.minLevel) ?? KernLevel.ERR,
    ...(sampleRate !== undefined && sampleRate > 0 ? { sampleRate } : {}),
    ...(ttlMs !== undefined && ttlMs >= 0 ? { ttlMs } : {}),
  };
}

function serializePolicy(p: PersistencePolicy): Record<string, unknown> {
  return {
    enabled: p.enabled,
    defaultMinLevel: kernLevelName(p.defaultMinLevel),
    rules: p.rules.map(r => ({
      facility: r.facility,
      minLevel: kernLevelName(r.minLevel),
      ...(r.sampleRate && r.sampleRate > 1 ? { sampleRate: r.sampleRate } : {}),
      ...(r.ttlMs ? { ttlMs: r.ttlMs } : {}),
    })),
    updatedAt: p.updatedAt,
    ...(p.updatedBy ? { updatedBy: p.updatedBy } : {}),
  };
}
