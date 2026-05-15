export interface RouteMeta {
  /** HTTP method (GET, POST, PUT, DELETE, etc.) */
  method: string;
  /** URL path, e.g. /info or /sandbox/:id */
  path: string;
  /** Human-readable description of the endpoint */
  description?: string;
  /** Example request body (for POST/PUT/PATCH) */
  requestBody?: unknown;
  /** Short description of the response (shown as comment in .http) */
  responseDescription?: string;
}
