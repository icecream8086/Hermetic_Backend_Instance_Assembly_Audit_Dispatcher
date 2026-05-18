declare const AUTHZ_ID_BRAND: unique symbol;
declare const POLICY_ID_BRAND: unique symbol;
declare const ROLE_ID_BRAND: unique symbol;

export type AuthzId = string & { readonly [AUTHZ_ID_BRAND]: true };
export type PolicyId = string & { readonly [POLICY_ID_BRAND]: true };
export type RoleId = string & { readonly [ROLE_ID_BRAND]: true };

export function createAuthzId(raw: string): AuthzId {
  if (!raw) throw new TypeError('AuthzId must not be empty');
  return raw as AuthzId;
}

export function generateAuthzId(): AuthzId {
  return `authz_${crypto.randomUUID()}` as AuthzId;
}

export function createPolicyId(raw: string): PolicyId {
  if (!raw) throw new TypeError('PolicyId must not be empty');
  return raw as PolicyId;
}

export function createRoleId(raw: string): RoleId {
  if (!raw) throw new TypeError('RoleId must not be empty');
  return raw as RoleId;
}

export enum PermissionEffect {
  ALLOW = 'allow',
  DENY = 'deny',
}

export enum PermissionAction {
  CREATE = 'create',
  READ = 'read',
  UPDATE = 'update',
  DELETE = 'delete',
  ADMIN = 'admin',
}

export interface PermissionCheck {
  readonly actor: string;
  readonly action: PermissionAction;
  readonly resource: string;
  readonly resourceId: string;
  readonly context?: Record<string, unknown>;
}

export interface PermissionResult {
  readonly allowed: boolean;
  readonly reason: string;
}

/**
 * A node in the permission policy DAG.
 *
 * Each node has an effect (ALLOW or DENY) and a `match()` function that
 * determines whether this policy applies to a given permission check.
 * Nodes are composed into a DAG via `PermissionDag`; edges define dependency
 * ordering for evaluation.
 *
 * @example
 * ```ts
 * const adminPolicy: PolicyNode = {
 *   id: createPolicyId('admin-rule'),
 *   effect: PermissionEffect.ALLOW,
 *   description: 'Admins can do anything',
 *   match: (p) => p.actor.startsWith('admin:'),
 * };
 * ```
 */
export interface PolicyNode {
  readonly id: PolicyId;
  readonly effect: PermissionEffect;
  readonly description?: string;
  /** Return true if this policy applies to the given check. */
  match(params: PermissionCheck): boolean;
}

/**
 * Extended result from DAG evaluation that includes which policy matched.
 */
export interface EvaluationResult extends PermissionResult {
  /** The policy node that produced the decision, if any. */
  readonly matchedPolicy?: PolicyNode;
}

export interface AuthzRecord {
  readonly id: AuthzId;
  readonly actor: string;
  readonly action: PermissionAction;
  readonly resource: string;
  readonly resourceId: string;
  readonly allowed: boolean;
  readonly reason: string;
  readonly timestamp: number;
  readonly metadata?: Record<string, unknown>;
}
