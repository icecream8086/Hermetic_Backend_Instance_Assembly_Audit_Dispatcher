/**
 * Middleware registry — table × chain architecture (inspired by iptables).
 *
 * Tables group middleware by function. Chains define request lifecycle hooks.
 * Within each (table, chain) pair, middleware execute in priority order.
 */

import type { MiddlewareHandler } from 'hono';

// ─── Tables (functional grouping) ───

export const enum MiddlewareTable {
  RAW    = 'raw',     // Pre-processing (body-limit, json-depth)
  FILTER = 'filter',  // Security filtering (rate-limit, authz)
  AUDIT  = 'audit',   // Audit recording
  NAT    = 'nat',     // Request rewriting (idempotency cache)
}

// ─── Chains (request lifecycle hooks) ───

export const enum MiddlewareChain {
  PRE_ROUTING = 'pre_routing',  // Before body parsing
  INPUT       = 'input',        // Permission checks
  HANDLER     = 'handler',      // Route handling
  OUTPUT      = 'output',       // After response
}

// ─── Registration ───

export interface MiddlewareRegistration {
  name: string;
  table: MiddlewareTable;
  chain: MiddlewareChain;
  priority: number;
  handler: MiddlewareHandler;
}

const _registry: MiddlewareRegistration[] = [];

/** Register a middleware with priority ordering. Lower priority = runs first. */
export function registerMiddleware(reg: MiddlewareRegistration): void {
  _registry.push(reg);
}

/** Get all registered middleware sorted by (chain → table → priority). */
export function getMiddlewareChain(): MiddlewareRegistration[] {
  const order = {
    [MiddlewareChain.PRE_ROUTING]: 0,
    [MiddlewareChain.INPUT]: 1,
    [MiddlewareChain.HANDLER]: 2,
    [MiddlewareChain.OUTPUT]: 3,
  };
  const tableOrder = {
    [MiddlewareTable.RAW]: 0,
    [MiddlewareTable.FILTER]: 1,
    [MiddlewareTable.NAT]: 2,
    [MiddlewareTable.AUDIT]: 3,
  };
  return [..._registry].sort((a, b) =>
    order[a.chain] - order[b.chain]
    || tableOrder[a.table] - tableOrder[b.table]
    || a.priority - b.priority
  );
}

/** Install all registered middleware onto a Hono app. */
export function installMiddleware(app: { use(handler: MiddlewareHandler): void }): void {
  for (const reg of getMiddlewareChain()) {
    app.use(reg.handler);
  }
}
