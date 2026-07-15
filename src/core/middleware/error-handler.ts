import type { ErrorHandler } from 'hono';
import { z, ZodError } from 'zod';
import { AppError } from '../types.ts';
import { fail } from '../response.ts';
import { KernLevel } from '../audit/kern-level.ts';

const ERROR_FACILITY = 'http';

/**
 * Global error handler.
 *
 * - ZodError: return 400 with validation issue messages.
 * - AppError: return structured error response at the error's status code.
 * - 5xx unhandled errors: record as KERN_ERR audit log, then return 500.
 */
export const globalErrorHandler: ErrorHandler = (err, c) => {
  if (err instanceof ZodError) {
    return c.json(fail('VALIDATION_ERROR', err.issues.map(i => i.message).join('; ')), 400);
  }

  if (err instanceof AppError) {
    return new Response(JSON.stringify(fail(err.code, err.message)), {
      status: err.statusCode,
      headers: { 'content-type': 'application/json' },
    });
  }

  const method = c.req.method;
  const url = c.req.url;
  const message = `Unhandled ${err.name}: ${err.message}`;
  const status = 500;

  // Fire-and-forget audit log (not awaited — must not block the error response)
  const audit = z.custom<{ write: (entry: { level: KernLevel; facility: string; message: string }) => void }>().optional().parse(c.get('audit'));
  if (audit) {
    audit.write({
      level: KernLevel.ERR,
      facility: ERROR_FACILITY,
      message: `5xx ${method} ${url} — ${message}`,
    });
  }

  // Always also write to console.error (surfaces in wrangler dev/tail)
  console.error(`[${String(KernLevel.ERR)}] ${message}`);

  return c.json(fail('INTERNAL_ERROR', 'Internal server error'), status);
};
