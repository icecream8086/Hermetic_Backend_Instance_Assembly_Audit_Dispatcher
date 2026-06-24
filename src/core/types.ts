export interface PaginatedResult<T> {
  items: T[];
  nextCursor?: string;
  total?: number;
}

export interface ErrorBody {
  error: string;
  code: number;
}

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
