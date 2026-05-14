import type { ErrorHandler } from 'hono';
import { AppError } from '../types.ts';

export const globalErrorHandler: ErrorHandler = (err, c) => {
  if (err instanceof AppError) {
    return c.json(
      { error: err.message, code: err.statusCode },
      err.statusCode as any,
    );
  }

  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal server error', code: 500 }, 500);
};
