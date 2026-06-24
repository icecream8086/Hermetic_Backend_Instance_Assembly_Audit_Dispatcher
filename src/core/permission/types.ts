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

// ═══════════════════════════════════════════════════════════
// Capability bitfield — decomposes superuser into named capabilities
// ═══════════════════════════════════════════════════════════

export const Capability = {
  NONE:                    0,
  // Sandbox
  SANDBOX_CREATE:          1 << 0,   // 1
  SANDBOX_DELETE:          1 << 1,   // 2
  SANDBOX_UPDATE:          1 << 2,   // 4
  SANDBOX_EXEC:            1 << 3,   // 8
  SANDBOX_ADMIN:           1 << 4,   // 16
  // Image
  IMAGE_PULL:              1 << 5,   // 32
  IMAGE_DELETE:            1 << 6,   // 64
  IMAGE_COMMIT:            1 << 7,   // 128
  // Volume
  VOLUME_MOUNT:            1 << 8,   // 256
  VOLUME_CREATE:           1 << 9,   // 512
  VOLUME_DELETE:           1 << 10,  // 1024
  // Network
  NETWORK_BIND:            1 << 11,  // 2048
  NETWORK_ADMIN:           1 << 12,  // 4096
  // User management
  USER_CREATE:             1 << 13,  // 8192
  USER_DELETE:             1 << 14,  // 16384
  USER_ADMIN:              1 << 15,  // 32768
  // System
  SYS_AUDIT_READ:          1 << 16,  // 65536
  SYS_AUDIT_WRITE:         1 << 17,  // 131072
  SYS_CONFIG:              1 << 18,  // 262144
  // Composite sets
  SANDBOX_CRUD:            (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3),  // 15
  IMAGE_CRUD:              (1 << 5) | (1 << 6) | (1 << 7),              // 224
  VOLUME_CRUD:             (1 << 8) | (1 << 9) | (1 << 10),             // 1792
  USER_CRUD:               (1 << 13) | (1 << 14),                        // 24576
  ALL:                      0x7FFFF,  // All 19 capabilities
} as const;

export type CapabilityValue = number;

/** Map an action string to the required capability bit. */
export function actionToCapability(action: string): CapabilityValue {
  switch (action) {
    case PermissionAction.CREATE: return Capability.SANDBOX_CREATE;
    case PermissionAction.DELETE: return Capability.SANDBOX_DELETE;
    case PermissionAction.UPDATE: return Capability.SANDBOX_UPDATE;
    default: return Capability.NONE;
  }
}

/** Check if a capability set contains the required capabilities. */
export function hasCapability(caps: CapabilityValue, required: CapabilityValue): boolean {
  return (caps & required) === required;
}

// ═══════════════════════════════════════════════════════════
// 3-layer denial tracking — DAC / Capability / MAC
// ═══════════════════════════════════════════════════════════

export const enum DenialLayer {
  DAC = 'dac',
  CAPABILITY = 'cap',
  MAC = 'mac',
}

/** Audit record type per denial layer — mirrors Linux audit types. */
export const DENIAL_AUDIT_TYPE: Record<DenialLayer, string> = {
  [DenialLayer.DAC]:        'SYSCALL',
  [DenialLayer.CAPABILITY]: 'CAPABILITIES',
  [DenialLayer.MAC]:        'AVC',
};

export interface PermissionCheck {
  readonly actor: string;
  /** Action string — accepts PermissionAction enum values or arbitrary strings for pattern matching. */
  readonly action: string;
  readonly resource: string;
  readonly resourceId: string;
  readonly context?: Record<string, unknown>;
}

export interface PermissionResult {
  readonly allowed: boolean;
  readonly reason: string;
  /** Which layer denied the request. Undefined if allowed. */
  readonly layer?: DenialLayer;
  /** Audit type for the denial event. Maps to 'SYSCALL' | 'CAPABILITIES' | 'AVC'. */
  readonly auditType?: string;
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
