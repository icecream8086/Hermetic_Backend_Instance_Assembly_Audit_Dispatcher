/**
 * Capability bitfield system — RHEL §3 model.
 *
 * Decomposes root's full authority into 19 discrete capability bits.
 * Each user has a permitted bitmask. Groups aggregate capabilities
 * via DAG inheritance (child inherits parent group's caps).
 *
 * Maps to RHEL:
 *   P (Permitted)   = user's own caps ∪ inherited group caps
 *   E (Effective)   = P (simplified: auto-activated for non-setuid context)
 *   B (Bounding)    = system max (ALL)
 *   I (Inheritable) = passed to child sandboxes
 *   A (Ambient)     = preserved across non-privileged exec
 *
 * For this project, we use a simplified 2-layer model:
 *   P = stored(user_caps) ∪ inherited(group_caps)
 *   E = P  (auto-effective in our context)
 */

// ═══════════════════════════════════════════════════════════
// Capability bits (19 individual + composite sets)
// ═══════════════════════════════════════════════════════════

export const Cap = {
  NONE:                    0,
  // Sandbox lifecycle
  SANDBOX_CREATE:          1 << 0,   // 1
  SANDBOX_DELETE:          1 << 1,   // 2
  SANDBOX_UPDATE:          1 << 2,   // 4
  SANDBOX_EXEC:            1 << 3,   // 8
  SANDBOX_ADMIN:           1 << 4,   // 16
  // Image management
  IMAGE_PULL:              1 << 5,   // 32
  IMAGE_DELETE:            1 << 6,   // 64
  IMAGE_COMMIT:            1 << 7,   // 128
  // Volume management
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
  SANDBOX_FULL:            (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4),
  IMAGE_FULL:              (1 << 5) | (1 << 6) | (1 << 7),
  VOLUME_FULL:             (1 << 8) | (1 << 9) | (1 << 10),
  NETWORK_FULL:            (1 << 11) | (1 << 12),
  USER_FULL:               (1 << 13) | (1 << 14) | (1 << 15),
  SYS_FULL:                (1 << 16) | (1 << 17) | (1 << 18),
  ALL:                      0x7FFFF,
} as const;

export type CapabilityValue = number;

/** Human-readable names for capability bits. */
export const CAP_NAMES: Readonly<Record<number, string>> = {
  [Cap.SANDBOX_CREATE]:  'SANDBOX_CREATE',
  [Cap.SANDBOX_DELETE]:  'SANDBOX_DELETE',
  [Cap.SANDBOX_UPDATE]:  'SANDBOX_UPDATE',
  [Cap.SANDBOX_EXEC]:    'SANDBOX_EXEC',
  [Cap.SANDBOX_ADMIN]:   'SANDBOX_ADMIN',
  [Cap.IMAGE_PULL]:      'IMAGE_PULL',
  [Cap.IMAGE_DELETE]:    'IMAGE_DELETE',
  [Cap.IMAGE_COMMIT]:    'IMAGE_COMMIT',
  [Cap.VOLUME_MOUNT]:    'VOLUME_MOUNT',
  [Cap.VOLUME_CREATE]:   'VOLUME_CREATE',
  [Cap.VOLUME_DELETE]:   'VOLUME_DELETE',
  [Cap.NETWORK_BIND]:    'NETWORK_BIND',
  [Cap.NETWORK_ADMIN]:   'NETWORK_ADMIN',
  [Cap.USER_CREATE]:     'USER_CREATE',
  [Cap.USER_DELETE]:     'USER_DELETE',
  [Cap.USER_ADMIN]:      'USER_ADMIN',
  [Cap.SYS_AUDIT_READ]:  'SYS_AUDIT_READ',
  [Cap.SYS_AUDIT_WRITE]: 'SYS_AUDIT_WRITE',
  [Cap.SYS_CONFIG]:      'SYS_CONFIG',
};

// ═══════════════════════════════════════════════════════════
// Bit operations
// ═══════════════════════════════════════════════════════════

export function hasCapability(caps: CapabilityValue, required: CapabilityValue): boolean {
  return (caps & required) === required;
}

export function addCapability(caps: CapabilityValue, add: CapabilityValue): CapabilityValue {
  return caps | add;
}

export function removeCapability(caps: CapabilityValue, remove: CapabilityValue): CapabilityValue {
  return caps & ~remove;
}

export function formatCapabilities(caps: CapabilityValue): string[] {
  const names: string[] = [];
  for (let bit = 0; bit < 19; bit++) {
    const v = 1 << bit;
    if (caps & v) names.push(CAP_NAMES[v] ?? `BIT_${bit}`);
  }
  return names;
}

/** Parse a comma-separated cap name list into a bitmask. */
export function parseCapabilities(names: string): CapabilityValue {
  let caps = 0;
  const entries = Object.entries(CAP_NAMES);
  for (const name of names.split(',').map(s => s.trim())) {
    for (const [bitStr, label] of entries) {
      if (label === name) caps |= parseInt(bitStr);
    }
  }
  return caps;
}

// ═══════════════════════════════════════════════════════════
// Action → Capability mapping
// ═══════════════════════════════════════════════════════════

export function actionToCapability(action: string): CapabilityValue {
  switch (action) {
    case 'create': return Cap.SANDBOX_CREATE;
    case 'delete': return Cap.SANDBOX_DELETE;
    case 'update': return Cap.SANDBOX_UPDATE;
    case 'execute': return Cap.SANDBOX_EXEC;
    case 'admin': case '*': return Cap.SANDBOX_ADMIN;
    case 'pull': return Cap.IMAGE_PULL;
    case 'commit': return Cap.IMAGE_COMMIT;
    case 'mount': return Cap.VOLUME_MOUNT;
    case 'bind': return Cap.NETWORK_BIND;
    case 'read': case 'list': return 0; // read is always allowed (DAC layer later rejects if needed)
    default: return 0; // unknown actions need no capability (MAC layer decides)
  }
}

// ═══════════════════════════════════════════════════════════
// User capability storage type
// ═══════════════════════════════════════════════════════════

export interface UserCapabilities {
  /** Total permitted capabilities (own ∪ inherited). */
  readonly permitted: CapabilityValue;
  /** User's directly-assigned capabilities (before inheritance). */
  readonly own: CapabilityValue;
  /** Capabilities inherited from user groups via DAG. */
  readonly inherited: CapabilityValue;
}

export const USER_CAP_KEY = 'user:cap:';
export const GROUP_CAP_KEY = 'group:cap:';
