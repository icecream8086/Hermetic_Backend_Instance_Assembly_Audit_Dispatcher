import type { ErrorCode } from './error-codes.ts';

/**
 * Unified API response envelope.
 *
 * Every endpoint returns `{ success, data, error }` so clients always
 * have a predictable structure to parse.
 *
 * @example
 * ```ts
 * import { ok, fail } from '../../core/response.ts';
 *
 * return c.json(ok(users));              // 200
 * return c.json(ok(newUser), 201);       // 201
 * return c.json(fail('NOT_FOUND', 'User not found'), 404);
 * ```
 */

export interface ApiSuccess<T> {
  success: true;
  data: T;
  error: null;
}

export interface ApiError {
  success: false;
  data: null;
  error: { code: string; message: string };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

/** Wrap a success payload. */
export function ok<T>(data: T): ApiSuccess<T> {
  return { success: true, data, error: null };
}

/**
 * Wrap an error.
 *
 * @param code — must be a member of the central ErrorCode union.
 *              Typos are caught at compile time.
 * @param message — human-readable description for the client.
 */
export function fail(code: ErrorCode, message: string): ApiError {
  return { success: false, data: null, error: { code, message } };
}
