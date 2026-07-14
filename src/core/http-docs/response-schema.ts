import { z } from 'zod';
import type { Context, Env } from 'hono';
import { fail } from '../response.ts';

/**
 * Shared defaultHook for OpenAPIHono handlers using `request.body`.
 * Returns 400 errors in ApiError format matching the global error handler.
 */
export function validationHook<E extends Env>(result: { success: boolean; error?: z.ZodError }, c: Context<E>) {
  if (!result.success) {
    return c.json(fail('VALIDATION_ERROR', result.error!.issues.map(i => i.message).join('; ')), 400);
  }
}

/**
 * Shared OpenAPI response schema wrappers.
 *
 * These match the runtime ApiSuccess/ApiError shapes from core/response.ts
 * so the OpenAPI spec stays in sync with actual response envelopes.
 *
 * Use OkResponse with z.unknown() as a transitional schema when the full
 * response shape hasn't been documented yet — at least the wrapper structure
 * (success + data) is captured.
 */

export const ErrorResponse = z.object({
  success: z.literal(false),
  data: z.null(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export function OkResponse<T extends z.ZodType>(schema: T) {
  return z.object({ success: z.literal(true), data: schema });
}

export function PaginatedResponse<T extends z.ZodType>(item: T) {
  return z.object({
    success: z.literal(true),
    data: z.object({
      items: z.array(item),
      total: z.number(),
      page: z.number(),
      limit: z.number(),
    }),
  });
}
