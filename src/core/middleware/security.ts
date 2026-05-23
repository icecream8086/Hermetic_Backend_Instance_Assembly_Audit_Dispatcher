import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../app.ts';

// ─── JSON depth limit ───

const DEFAULT_MAX_DEPTH = 10;

function checkDepth(obj: unknown, maxDepth: number, depth = 0): boolean {
  if (depth > maxDepth) return false;
  if (obj === null || typeof obj !== 'object') return true;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (!checkDepth(item, maxDepth, depth + 1)) return false;
    }
    return true;
  }
  for (const val of Object.values(obj as Record<string, unknown>)) {
    if (!checkDepth(val, maxDepth, depth + 1)) return false;
  }
  return true;
}

/**
 * Middleware that limits JSON nesting depth.
 *
 * After the body is parsed as JSON (via c.req.json()), checks the parsed
 * value's maximum nesting depth.  If it exceeds `maxDepth`, returns a 400
 * response before the route handler runs.
 *
 * Must be placed AFTER body-limit middleware (which rejects oversized
 * payloads) and BEFORE any middleware that consumes the body.
 */
export function jsonDepthLimit(maxDepth = DEFAULT_MAX_DEPTH): MiddlewareHandler<{ Variables: AppContext }> {
  return async (c, next) => {
    const ct = c.req.header('content-type') ?? '';
    if (!ct.includes('application/json')) {
      await next();
      return;
    }

    // Replace c.req.json() with a wrapper that checks depth
    const originalJson = c.req.json.bind(c.req);
    c.req.json = async () => {
      const body = await originalJson();
      if (!checkDepth(body, maxDepth)) {
        throw new BodyDepthError(maxDepth);
      }
      return body;
    };

    try {
      await next();
    } catch (err) {
      if (err instanceof BodyDepthError) {
        return c.json(
          { success: false, data: null, error: { code: 'BODY_TOO_DEEP', message: err.message } },
          400,
        );
      }
      throw err;
    }
  };
}

class BodyDepthError extends Error {
  constructor(maxDepth: number) {
    super(`JSON nesting depth exceeds limit of ${maxDepth}`);
    this.name = 'BodyDepthError';
  }
}
