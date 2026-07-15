import { describe, it, expect } from 'vitest';
import { globalErrorHandler } from '../../../src/core/middleware/error-handler.ts';
import { AppError } from '../../../src/core/types.ts';

function fakeCtx(overrides?: Record<string, any>) {
  return {
    req: { method: 'GET', url: 'http://localhost/api/test', ...overrides?.req },
    json(body: any, status: number) { return { body, status }; },
    get(_key: string) { return undefined; },
    ...overrides,
  } as any;
}

describe('globalErrorHandler', () => {
  it('returns structured AppError response with correct status and code', async () => {
    const err = new AppError(404, 'SANDBOX_NOT_FOUND', 'Sandbox abc not found');
    const result = await globalErrorHandler(err, fakeCtx()) as Response;
    expect(result.status).toBe(404);
    const body = await result.json();
    expect(body.error.code).toBe('SANDBOX_NOT_FOUND');
    expect(body.error.message).toBe('Sandbox abc not found');
    expect(body.success).toBe(false);
  });

  it('returns AppError with 401 for auth failures', async () => {
    const err = new AppError(401, 'UNAUTHORIZED', 'Invalid token');
    const result = await globalErrorHandler(err, fakeCtx()) as Response;
    expect(result.status).toBe(401);
  });

  it('returns AppError with 429 for rate limiting', async () => {
    const err = new AppError(429, 'RATE_LIMITED', 'Too many requests');
    const result = await globalErrorHandler(err, fakeCtx()) as Response;
    expect(result.status).toBe(429);
  });

  it('returns 500 INTERNAL_ERROR for non-AppError exceptions (no stack leak)', () => {
    const err = new TypeError('Cannot read properties of undefined');
    const result = globalErrorHandler(err, fakeCtx()) as any;
    expect(result.status).toBe(500);
    expect(result.body.error.code).toBe('INTERNAL_ERROR');
    // Must NOT expose the real error type
    expect(result.body.error.message).toBe('Internal server error');
    expect(result.body.error.message).not.toContain('undefined');
  });

  it('returns 500 for generic Error', () => {
    const err = new Error('Something broke');
    const result = globalErrorHandler(err, fakeCtx()) as any;
    expect(result.status).toBe(500);
    expect(result.body.error.message).toBe('Internal server error');
  });

  it('still returns 500 even when audit writer throws', () => {
    const ctx = fakeCtx({
      get(_key: string) {
        return { write: async () => { throw new Error('audit down'); } };
      },
    });
    const err = new Error('real error');
    const result = globalErrorHandler(err, ctx) as any;
    expect(result.status).toBe(500);
    expect(result.body.error.code).toBe('INTERNAL_ERROR');
  });
});
