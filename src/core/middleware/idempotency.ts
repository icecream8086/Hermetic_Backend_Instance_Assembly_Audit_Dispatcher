import type { MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { IAtomicStore } from '../store/interfaces.ts';

/** Env shape this middleware requires on `c.var`. */
interface IdempotencyEnv { Variables: { stores: { atomic: IAtomicStore } } }

/**
 * Idempotency middleware — requires `IAtomicStore` bound to `c.var.stores`.
 * The client provides `Idempotency-Key` header.
 * On first request: stores the response. On replay: returns the stored response.
 */
export function idempotency(): MiddlewareHandler<IdempotencyEnv> {
  return async (c, next) => {
    const key = c.req.header('Idempotency-Key');
    if (!key) {
      await next();
      return;
    }

    const stores = c.var.stores.atomic;

    const storageKey = `idempotency:${key}`;

    const existing = await stores.get<string>(storageKey);
    if (existing) {
      try {
        const cached = JSON.parse(existing.value) as { status: number; body: unknown };
        return c.json(cached.body, cached.status as ContentfulStatusCode);
      } catch { /* corrupted data — fall through to re-execute */ }
    }

    await next();

    if (c.res.status >= 200 && c.res.status < 500) {
      try {
        const clone = (await c.res.clone().json());
        await stores.set(
          storageKey,
          JSON.stringify({ status: c.res.status, body: clone }),
          null,
        );
      } catch { /* non-JSON response — skip caching */ }
    }
  };
}
