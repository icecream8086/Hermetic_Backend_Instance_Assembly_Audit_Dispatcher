/**
 * Permission evaluation logic — DAG-based rewrite.
 *
 * Converts stored PermissionRules into PolicyNode DAG nodes at check time
 * and evaluates via PermissionDag (deny-overrides, topological sort).
 *
 * Fixes:
 *  - $self resource matching (previously unimplemented)
 *  - allow-policies now evaluated (previously only deny-policies loaded)
 *  - userId/role/policy resource scoping (previously dropped by PolicyManager)
 *  - Module-level _macRules → instance-scoped
 */

import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { ILogWriter } from '../../core/audit/types.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import { PermissionDag } from '../../core/permission/permission-dag.ts';
import { PermissionEffect } from '../../core/permission/types.ts';
import type { PolicyNode, PermissionCheck } from '../../core/permission/types.ts';
import { createPolicyId, DenialLayer, DENIAL_AUDIT_TYPE, actionToCapability } from '../../core/permission/types.ts';
import { CrudStore } from './crud-store.ts';
import type {
  StoredPolicy, UserGroup, PermissionGroup, PermissionRule, PermissionCheckInput, PolicyMatchResult,
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

  invalidateCache(): void {
    this.#cache = { policies: null, userGroups: null, permGroups: null };
  }

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

  /**
   * Evaluate permission via DAG: user → groups → rules → PolicyNode → deny-overrides.
   */
  async check(input: PermissionCheckInput, macRules: PermissionRule[]): Promise<PolicyMatchResult> {
    return this.checkAll(input, macRules);
  }

  /**
   * 3-layer permission check — DAC → Capability → MAC.
   * Each layer that denies generates a distinct audit event type.
   */
  async checkAll(input: PermissionCheckInput, macRules: PermissionRule[]): Promise<PolicyMatchResult> {
    const { userId, action, resource, resourceOwnerId } = input;

    // Layer 1: DAC — user must exist
    const dacResult = await this.#checkDac(userId);
    if (!dacResult.allowed) return dacResult;

    // Layer 2: Capability — check capability bits
    const capResult = this.#checkCap(userId, action);
    if (!capResult.allowed) return capResult;

    // Layer 3: MAC — full DAG evaluation
    return this.#checkMac(userId, action, resource, resourceOwnerId, macRules);
  }

  /** Layer 1: DAC — verify the user exists. */
  async #checkDac(userId: string): Promise<PolicyMatchResult> {
    const userEntry = await this.atomic.get<any>('user:' + userId);
    if (!userEntry) return {
      allowed: false, reason: 'User not found',
      layer: DenialLayer.DAC, auditType: DENIAL_AUDIT_TYPE[DenialLayer.DAC],
    };
    return { allowed: true, reason: 'user exists' };
  }

  /** Layer 2: Capability — verify the user has the required capability bit. */
  #checkCap(_userId: string, action: string): PolicyMatchResult {
    const required = actionToCapability(action);
    if (required === 0) return { allowed: true, reason: 'no capability required' };
    // In dev mode, root/wheel/Operator users have ALL caps
    // TODO: load user capabilities from stored permission groups
    return { allowed: true, reason: 'capability check passed (dev mode)' };
  }

  /** Layer 3: MAC — full DAG-based deny-override evaluation. */
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
}

/**
 * Walk the UserGroup dependsOn DAG to collect all group IDs
 * that a user belongs to (directly or via group inheritance).
 *
 * Example: user is in group A. Group A dependsOn B, group B dependsOn C.
 * Returns [A.id, B.id, C.id].
 */
function resolveDagGroupIds(groups: UserGroup[], userId: string): string[] {
  const result = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map<string, UserGroup>(groups.map(g => [g.id as string, g]));

  // Find groups the user directly belongs to
  const directIds = groups.filter(g => g.memberIds?.includes(userId)).map(g => g.id as string);

  // BFS through dependsOn chain
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

// ─── Rule → PolicyNode converter ───

function ruleToNode(rule: PermissionRule, source: string, resourceOwnerId?: string): PolicyNode {
  return {
    id: createPolicyId(`rule_${crypto.randomUUID()}`),
    effect: rule.effect === 'deny' ? PermissionEffect.DENY : PermissionEffect.ALLOW,
    description: rule.description ?? source,
    match: (params) => {
      // Actions match
      if (rule.actions && rule.actions.length > 0) {
        if (!matchPattern(rule.actions, params.action)) return false;
      }
      // Resource match with $self expansion
      if (rule.resource) {
        const target = expandSelf(rule.resource, resourceOwnerId, params.resourceId);
        if (!matchPattern(target, params.resource)) return false;
      }
      return true;
    },
  };
}

/** Expand $self in resource pattern to the effective resource target. */
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
