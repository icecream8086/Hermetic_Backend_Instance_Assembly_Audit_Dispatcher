/**
 * Standard CRUD action names. Every REST resource with CRUD operations
 * must handle all five. Use Record<CrudAction, …> for compile-time
 * exhaustiveness: omit one → tsc error.
 */
export type CrudAction = 'create' | 'list' | 'get' | 'update' | 'delete';

/** Page-based paginated result for list endpoints. */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}
