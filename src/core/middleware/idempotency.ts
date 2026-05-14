import type { MiddlewareHandler } from 'hono';
import type { IAtomicStore } from '../store/interfaces.ts';

/**
 * Idempotency middleware — requires `IAtomicStore` bound to `c.var.stores`.
 * The client provides `Idempotency-Key` header.
 * On first request: stores the response. On replay: returns the stored response.
 */
export function idempotency(): MiddlewareHandler {
  return async (c, next) => {
    const key = c.req.header('Idempotency-Key');
    if (!key) {
      await next();
      return;
    }

    const stores: IAtomicStore | undefined = (c as any).var.stores?.atomic;
    if (!stores) {
      await next();
      return;
    }

    const storageKey = `idempotency:${key}`;

    const existing = await stores.get<string>(storageKey);
    if (existing) {
      const cached = JSON.parse(existing.value) as { status: number; body: unknown };
      return c.json(cached.body, cached.status as any);
    }

    await next();

    if (c.res.status >= 200 && c.res.status < 500) {
      const clone = (await c.res.clone().json()) as unknown;
      await stores.set(
        storageKey,
        JSON.stringify({ status: c.res.status, body: clone }),
        null,
      );
    }
  };
}
