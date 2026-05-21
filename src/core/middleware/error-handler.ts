import type { ErrorHandler } from 'hono';
import { AppError } from '../types.ts';
import { fail } from '../response.ts';
import type { IAuditWriter } from '../audit/types.ts';
import { KernLevel } from '../audit/kern-level.ts';

const ERROR_FACILITY = 'http';

/**
 * Global error handler.
 *
 * - AppError: return structured error response at the error's status code.
 * - 5xx unhandled errors: record as KERN_ERR audit log, then return 500.
 */
export const globalErrorHandler: ErrorHandler = (err, c) => {
  if (err instanceof AppError) {
    return c.json(fail(err.code, err.message), err.statusCode as any);
  }

  const method = c.req.method;
  const url = c.req.url;
  const message = `Unhandled ${err.name}: ${err.message}`;
  const status = 500;

  // Fire-and-forget audit log (not awaited — must not block the error response)
  const audit = c.get('audit') as IAuditWriter | undefined;
  if (audit) {
    audit.write({
      level: KernLevel.ERR,
      facility: ERROR_FACILITY,
      message: `5xx ${method} ${url} — ${message}`,
    }).catch(() => {});
  }

  // Always also write to console.error (surfaces in wrangler dev/tail)
  console.error(`[${KernLevel.ERR}] ${message}`);

  return c.json(fail('INTERNAL_ERROR', 'Internal server error'), status);
};
