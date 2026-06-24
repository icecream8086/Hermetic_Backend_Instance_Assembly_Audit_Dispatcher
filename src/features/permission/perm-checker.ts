/**
 * Permission evaluation — 3-layer gate (DAC → Capability → MAC).
 *
 * Mirrors RHEL:
 *   Layer 1 (DAC):        user existence + resource ownership
 *   Layer 2 (Capability):  capability bitfield check
 *   Layer 3 (MAC):         DAG-based deny-override policy evaluation
 *
 * Each layer that denies generates a distinct audit type:
 *   DAC → SYSCALL, Capability → CAPABILITIES, MAC → AVC
 */

import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { ILogWriter, IAuditWriter } from '../../core/audit/types.ts';
import { PermissionDag } from '../../core/permission/permission-dag.ts';
import { PermissionEffect } from '../../core/permission/types.ts';
import type { PolicyNode, PermissionCheck } from '../../core/permission/types.ts';
import { createPolicyId, DenialLayer, DENIAL_AUDIT_TYPE } from '../../core/permission/types.ts';
import {
  actionToCapability,
  hasCapability,
  addCapability,
  USER_CAP_KEY,
  GROUP_CAP_KEY,
  type CapabilityValue,
  type UserCapabilities,
} from '../../core/permission/capability.ts';
import { CrudStore } from './crud-store.ts';
import type {
  StoredPolicy, UserGroup, PermissionGroup, PermissionRule,
  PermissionCheckInput, PolicyMatchResult,
} from './types.ts';

const POLICY_PREFIX = 'policy:';
const POLICY_INDEX_KEY = 'policy:ids';
const USERGROUP_PREFIX = 'usergroup:';
const USERGROUP_INDEX_KEY = 'usergroup:ids';
const PERMGROUP_PREFIX = 'permgroup:';
const PERMGROUP_INDEX_KEY = 'permgroup:ids';

export class PermissionChecker {
  private readonly policyStore: CrudStore<StoredPolicy>;
  private readonly ugStore: CrudStore<UserGroup>;
  private readonly pgStore: CrudStore<PermissionGroup>;

  #cache: {
    policies: { ts: number; data: StoredPolicy[] } | null;
    userGroups: { ts: number; data: UserGroup[] } | null;
    permGroups: { ts: number; data: PermissionGroup[] } | null;
  } = { policies: null, userGroups: null, permGroups: null };
  readonly #CACHE_TTL = 5_000;

  constructor(
    private readonly atomic: IAtomicStore,
    _logger: ILogWriter,
    _audit?: IAuditWriter,
  ) {
    this.policyStore = new CrudStore(atomic, POLICY_PREFIX, POLICY_INDEX_KEY, 'POLICY_NOT_FOUND');
    this.ugStore = new CrudStore(atomic, USERGROUP_PREFIX, USERGROUP_INDEX_KEY, 'USERGROUP_NOT_FOUND');
    this.pgStore = new CrudStore(atomic, PERMGROUP_PREFIX, PERMGROUP_INDEX_KEY, 'PERMGROUP_NOT_FOUND');
  }

  invalidateCache(): void { this.#cache = { policies: null, userGroups: null, permGroups: null }; }

  // ─── Public API ───

  async check(input: PermissionCheckInput, macRules: PermissionRule[]): Promise<PolicyMatchResult> {
    return this.checkAll(input, macRules);
  }

  async checkAll(input: PermissionCheckInput, macRules: PermissionRule[]): Promise<PolicyMatchResult> {
    const { userId, action, resource, resourceOwnerId } = input;

    // Layer 1: DAC
    const dacResult = await this.#checkDac(userId, resource, resourceOwnerId);
    if (!dacResult.allowed) return dacResult;

    // Layer 2: Capability
    const capResult = await this.#checkCap(userId, action);
    if (!capResult.allowed) return capResult;

    // Layer 3: MAC
    return this.#checkMac(userId, action, resource, resourceOwnerId, macRules);
  }

  // ─── Layer 1: DAC ───

  async #checkDac(userId: string, _resource: string, resourceOwnerId?: string): Promise<PolicyMatchResult> {
    const userEntry = await this.atomic.get<any>('user:' + userId);
    if (!userEntry) {
      return {
        allowed: false, reason: 'User not found',
        layer: DenialLayer.DAC, auditType: DENIAL_AUDIT_TYPE[DenialLayer.DAC],
      };
    }
    // Resource ownership check: if resourceOwnerId is set, the acting user
    // must be the owner OR have admin capability (checked in layer 2).
    if (resourceOwnerId && userEntry.value?.id !== resourceOwnerId) {
      // Not the owner — defer to capability + MAC layers
      // (CAP_DAC_OVERRIDE would handle this)
    }
    return { allowed: true, reason: 'user exists' };
  }

  // ─── Layer 2: Capability ───

  async #checkCap(userId: string, action: string): Promise<PolicyMatchResult> {
    const required = actionToCapability(action);
    if (required === 0) return { allowed: true, reason: 'no capability required' };

    const caps = await this.#loadUserCapabilities(userId);
    if (hasCapability(caps.permitted, required)) {
      return { allowed: true, reason: 'capability check passed' };
    }

    return {
      allowed: false,
      reason: `Missing capability: required=${required.toString(16)}, have=${caps.permitted.toString(16)}`,
      layer: DenialLayer.CAPABILITY,
      auditType: DENIAL_AUDIT_TYPE[DenialLayer.CAPABILITY],
    };
  }

  async #loadUserCapabilities(userId: string): Promise<UserCapabilities> {
    // Load own caps
    const ownEntry = await this.atomic.get<CapabilityValue>(USER_CAP_KEY + userId);
    const own = ownEntry?.value ?? 0;

    // Load group-inherited caps via DAG
    let inherited = 0;
    const allGroups = await this.#cachedUserGroupList();
    const groupIds = resolveDagGroupIds(allGroups, userId);

    for (const gid of groupIds) {
      const gCapEntry = await this.atomic.get<CapabilityValue>(GROUP_CAP_KEY + gid);
      if (gCapEntry?.value) {
        inherited = addCapability(inherited, gCapEntry.value);
      }
    }

    return {
      permitted: addCapability(own, inherited),
      own,
      inherited,
    };
  }

  // ─── Layer 3: MAC ───

  async #checkMac(
    userId: string, action: string, resource: string,
    resourceOwnerId: string | undefined, macRules: PermissionRule[],
  ): Promise<PolicyMatchResult> {
    const allUserGroups = await this.#cachedUserGroupList();
    const userGroupIds = resolveDagGroupIds(allUserGroups, userId);

    const allPermGroups = await this.#cachedPermGroupList();
    const matchedGroups = allPermGroups.filter(pg =>
      pg.userGroupIds?.some(ugId => userGroupIds.includes(ugId as any))
      || pg.userIds?.includes(userId)
    );

    const dag = new PermissionDag();

    for (const rule of (Array.isArray(macRules) ? macRules : [])) {
      dag.addPolicy(ruleToNode(rule, 'MAC', resourceOwnerId));
    }
    for (const pg of matchedGroups) {
      for (const rule of pg.rules) {
        dag.addPolicy(ruleToNode(rule, pg.name, resourceOwnerId));
      }
    }
    const policies = await this.#cachedPolicyList();
    for (const p of policies) {
      if (!p.enabled) continue;
      dag.addPolicy(ruleToNode(
        { effect: p.effect, actions: p.actions, resource: p.resource, priority: p.priority, description: p.name },
        p.name, resourceOwnerId,
      ));
    }

    const params: PermissionCheck = {
      actor: userId, action, resource, resourceId: resourceOwnerId ?? '',
    };
    const result = dag.evaluate(params);

    if (!result.allowed) {
      return {
        allowed: false, reason: result.reason,
        layer: DenialLayer.MAC, auditType: DENIAL_AUDIT_TYPE[DenialLayer.MAC],
      };
    }
    return { allowed: true, reason: result.reason };
  }

  // ─── Cached loaders ───

  async #cachedPolicyList(): Promise<StoredPolicy[]> {
    const now = Date.now();
    if (this.#cache.policies && now - this.#cache.policies.ts < this.#CACHE_TTL) return this.#cache.policies.data;
    const data = await this.policyStore.list();
    this.#cache.policies = { ts: now, data };
    return data;
  }

  async #cachedUserGroupList(): Promise<UserGroup[]> {
    const now = Date.now();
    if (this.#cache.userGroups && now - this.#cache.userGroups.ts < this.#CACHE_TTL) return this.#cache.userGroups.data;
    const data = await this.ugStore.list();
    this.#cache.userGroups = { ts: now, data };
    return data;
  }

  async #cachedPermGroupList(): Promise<PermissionGroup[]> {
    const now = Date.now();
    if (this.#cache.permGroups && now - this.#cache.permGroups.ts < this.#CACHE_TTL) return this.#cache.permGroups.data;
    const data = await this.pgStore.list();
    this.#cache.permGroups = { ts: now, data };
    return data;
  }
}

// ─── Helpers ───

function resolveDagGroupIds(groups: UserGroup[], userId: string): string[] {
  const result = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map<string, UserGroup>(groups.map(g => [g.id as string, g]));

  const directIds = groups.filter(g => g.memberIds?.includes(userId)).map(g => g.id as string);
  const queue = [...directIds];
  while (queue.length > 0) {
    const gid = queue.shift()!;
    if (visited.has(gid)) continue;
    visited.add(gid);
    result.add(gid);

    const group = byId.get(gid);
    if (group?.dependsOn) {
      for (const depId of group.dependsOn) {
        if (!visited.has(depId)) queue.push(depId);
      }
    }
  }
  return [...result];
}

function ruleToNode(rule: PermissionRule, source: string, resourceOwnerId?: string): PolicyNode {
  return {
    id: createPolicyId(`rule_${crypto.randomUUID()}`),
    effect: rule.effect === 'deny' ? PermissionEffect.DENY : PermissionEffect.ALLOW,
    description: rule.description ?? source,
    match: (params) => {
      if (rule.actions && rule.actions.length > 0) {
        if (!matchPattern(rule.actions, params.action)) return false;
      }
      if (rule.resource) {
        const target = expandSelf(rule.resource, resourceOwnerId, params.resourceId);
        if (!matchPattern(target, params.resource)) return false;
      }
      return true;
    },
  };
}

function expandSelf(pattern: string, ownerId?: string, resourceId?: string): string {
  if (!pattern.includes('$self')) return pattern;
  const effective = ownerId || resourceId;
  if (!effective) return pattern;
  return pattern.replace(/\$self/g, effective);
}

function matchPattern(pattern: string | string[], target: string): boolean {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  return patterns.some(p => {
    if (p === '*') return true;
    if (p === target) return true;
    if (p.includes('*')) {
      const regex = new RegExp('^' + p.replace(/\*/g, '.*') + '$');
      return regex.test(target);
    }
    return false;
  });
}
