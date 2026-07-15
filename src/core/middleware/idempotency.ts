import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { IAtomicStore } from '../store/interfaces.ts';

const { parse: parseJson } = JSON;

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
        const cached: unknown = parseJson(existing.value);
        const cachedSchema = z.object({ status: z.number(), body: z.unknown() });
        const parsed = cachedSchema.parse(cached);
        return new Response(JSON.stringify(parsed.body), {
          status: parsed.status,
          headers: { 'content-type': 'application/json' },
        });
      } catch {
        console.debug("corrupted data — fall through to re-execute");
      }
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
      } catch {
        console.debug("non-JSON response — skip caching");
      }
    }
  };
}
