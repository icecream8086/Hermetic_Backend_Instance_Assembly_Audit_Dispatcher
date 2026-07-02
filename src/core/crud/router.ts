import type { Hono } from 'hono';
import type { CrudAction } from './types.ts';

/**
 * Map each CrudAction to a route registration callback.
 *
 * Record<CrudAction, …> enforces at compile time that every CRUD action
 * has a handler. Omit one → "Property X is missing" tsc error.
 *
 * @example
 * const handlers: CrudHandlerMap = {
 *   create: (r) => r.post('/', createHandler),
 *   list:   (r) => r.get('/', listHandler),
 *   get:    (r) => r.get('/:id', getHandler),
 *   update: (r) => r.put('/:id', updateHandler),
 *   delete: (r) => r.delete('/:id', deleteHandler),
 * };
 * registerCrudRoutes(router, handlers);
 */
export type CrudHandlerMap = Record<CrudAction, (router: Hono) => void>;

/** Register all CRUD routes from a handler map. Returns the router for chaining. */
export function registerCrudRoutes(router: Hono, handlers: CrudHandlerMap): Hono {
  for (const register of Object.values(handlers)) {
    register(router);
  }
  return router;
}
